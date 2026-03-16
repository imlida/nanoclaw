import AiBot, {
  generateReqId,
  type BaseMessage,
  type FileMessage,
  type ImageMessage,
  type ImageContent,
  type MixedMessage,
  type MixedMsgItem,
  type VoiceMessage,
  type WsFrame,
  type WsFrameHeaders,
} from '@wecom/aibot-node-sdk';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel, StreamSession } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

/** Maximum content size for a single replyStream call (WeCom limit: 20480 bytes). */
const STREAM_MAX_BYTES = 20480;

type WecomFrame =
  | WsFrame<BaseMessage>
  | WsFrame<FileMessage>
  | WsFrame<ImageMessage>
  | WsFrame<MixedMessage>
  | WsFrame<VoiceMessage>;

function toIsoTimestamp(value?: number): string {
  if (!value) return new Date().toISOString();
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function toChatJid(body: BaseMessage): {
  jid: string;
  isGroup: boolean;
  targetId: string;
} | null {
  if (body.chattype === 'group') {
    if (!body.chatid) return null;
    return {
      jid: `wc:group:${body.chatid}`,
      isGroup: true,
      targetId: body.chatid,
    };
  }

  const userId = body.from?.userid;
  if (!userId) return null;
  return { jid: `wc:user:${userId}`, isGroup: false, targetId: userId };
}

function extractQuoteText(quote: unknown): string | undefined {
  if (!quote || typeof quote !== 'object') return undefined;

  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) parts.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        visit(nested);
      }
    }
  };

  visit(quote);

  if (parts.length === 0) return undefined;
  return Array.from(new Set(parts)).join('\n').slice(0, 400);
}

/** Directory for storing downloaded WeCom media files. */
const WECOM_MEDIA_DIR = path.join(
  process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  'wecom-media',
);

/** Ensure the media directory exists. */
function ensureMediaDir(): void {
  if (!fs.existsSync(WECOM_MEDIA_DIR)) {
    fs.mkdirSync(WECOM_MEDIA_DIR, { recursive: true });
  }
}

/** Generate a unique filename for downloaded media. */
function generateMediaFilename(ext: string = 'jpg'): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `wecom-${timestamp}-${random}.${ext}`;
}

/**
 * Format image information for inclusion in message content.
 * Returns a Markdown-style description with the local file path if available.
 */
function formatImageInfo(
  image: ImageContent | undefined,
  localPath?: string,
): string {
  if (localPath) {
    // Return Markdown image syntax with local file path
    return `![WeCom Image](${localPath})`;
  }
  if (image?.url) {
    // Fallback: include URL info (note: encrypted, 5-min expiry)
    return `[WeCom image: ${image.url.substring(0, 80)}...]`;
  }
  return '[WeCom image attachment]';
}

function extractMixedText(
  body: MixedMessage,
  imagePathMap?: Map<number, string>,
): string {
  const parts: string[] = [];
  const items = body.mixed?.msg_item || [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.msgtype === 'text' && item.text?.content) {
      parts.push(item.text.content.trim());
    } else if (item.msgtype === 'image') {
      const localPath = imagePathMap?.get(i);
      parts.push(formatImageInfo(item.image, localPath));
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}

function buildContent(
  body: BaseMessage,
  imageLocalPath?: string,
  mixedImagePaths?: Map<number, string>,
): string {
  switch (body.msgtype) {
    case 'text':
      return body.text?.content?.trim() || '';
    case 'voice':
      return body.voice?.content?.trim() || '[WeCom voice message]';
    case 'mixed':
      return extractMixedText(body as MixedMessage, mixedImagePaths);
    case 'image': {
      const imageBody = body as ImageMessage;
      return formatImageInfo(imageBody.image, imageLocalPath);
    }
    case 'file': {
      const fileBody = body as FileMessage;
      if (fileBody.file?.url) {
        return `[WeCom file: ${fileBody.file.url.substring(0, 80)}...]`;
      }
      return '[WeCom file attachment]';
    }
    default:
      return `[WeCom ${String(body.msgtype)} message]`;
  }
}

function withQuote(content: string, quote: unknown): string {
  const quoteText = extractQuoteText(quote);
  if (!quoteText) return content;
  if (!content) return `[Quoted message]\n${quoteText}`;
  return `${content}\n\n[Quoted message]\n${quoteText}`;
}

function parseTargetJid(jid: string): string | null {
  if (jid.startsWith('wc:group:')) return jid.slice('wc:group:'.length);
  if (jid.startsWith('wc:user:')) return jid.slice('wc:user:'.length);
  return null;
}

export class WecomChannel implements Channel {
  name = 'wecom';

  private client: InstanceType<typeof AiBot.WSClient> | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  /** Most recent inbound frame per JID — needed for replyStream. */
  private lastFrameByJid = new Map<string, WsFrameHeaders>();

  constructor(
    private opts: ChannelOpts,
    private botId: string,
    private secret: string,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.client = new AiBot.WSClient({
      botId: this.botId,
      secret: this.secret,
      logger: {
        debug: (message, ...args) => logger.debug({ args }, message),
        info: (message, ...args) => logger.info({ args }, message),
        warn: (message, ...args) => logger.warn({ args }, message),
        error: (message, ...args) => logger.error({ args }, message),
      },
    });

    this.registerEventHandlers(this.client);

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const handleAuthenticated = () => {
        this.connected = true;
        logger.info('WeCom bot connected');
        resolve();
      };

      const handleError = (err: Error) => {
        logger.error({ err }, 'WeCom SDK error');
        if (!this.connected) reject(err);
      };

      const handleDisconnected = (reason: string) => {
        this.connected = false;
        logger.warn({ reason }, 'WeCom SDK disconnected');
      };

      this.client!.on('authenticated', handleAuthenticated);
      this.client!.on('error', handleError);
      this.client!.on('disconnected', handleDisconnected);
    }).finally(() => {
      if (!this.connected) {
        this.connectPromise = null;
      }
    });

    this.client.connect();
    return this.connectPromise;
  }

  private registerEventHandlers(
    client: InstanceType<typeof AiBot.WSClient>,
  ): void {
    client.on(
      'message.text',
      (frame: WecomFrame) => void this.handleFrame(frame),
    );
    client.on(
      'message.voice',
      (frame: WecomFrame) => void this.handleFrame(frame),
    );
    client.on(
      'message.mixed',
      (frame: WecomFrame) => void this.handleFrame(frame),
    );
    client.on(
      'message.image',
      (frame: WecomFrame) => void this.handleFrame(frame),
    );
    client.on(
      'message.file',
      (frame: WecomFrame) => void this.handleFrame(frame),
    );
  }

  /**
   * Download an image from WeCom and save it locally.
   * Returns the local file path on success, undefined on failure.
   */
  private async downloadImage(
    url: string,
    aeskey?: string,
  ): Promise<string | undefined> {
    if (!this.client || !url) return undefined;

    try {
      ensureMediaDir();
      const { buffer, filename } = await this.client.downloadFile(url, aeskey);

      // Determine file extension from filename or default to jpg
      const ext = filename ? path.extname(filename).slice(1) || 'jpg' : 'jpg';
      const localFilename = generateMediaFilename(ext);
      const localPath = path.join(WECOM_MEDIA_DIR, localFilename);

      fs.writeFileSync(localPath, buffer);
      logger.debug(
        { localPath, originalFilename: filename },
        'WeCom image downloaded',
      );

      return localPath;
    } catch (err) {
      logger.warn(
        { err, url: url.substring(0, 50) },
        'Failed to download WeCom image',
      );
      return undefined;
    }
  }

  /**
   * Download all images from a mixed message.
   * Returns a map of item index to local file path.
   */
  private async downloadMixedImages(
    body: MixedMessage,
  ): Promise<Map<number, string>> {
    const pathMap = new Map<number, string>();
    const items = body.mixed?.msg_item || [];

    const downloadPromises = items.map(async (item, index) => {
      if (item.msgtype === 'image' && item.image?.url) {
        const localPath = await this.downloadImage(
          item.image.url,
          item.image.aeskey,
        );
        if (localPath) {
          pathMap.set(index, localPath);
        }
      }
    });

    await Promise.all(downloadPromises);
    return pathMap;
  }

  private async handleFrame(frame: WecomFrame): Promise<void> {
    const body = frame.body;
    if (!body?.msgid || !body.from?.userid) return;

    const chatInfo = toChatJid(body);
    if (!chatInfo) return;

    // Store the frame for streaming replies (replyStream needs the original req_id)
    this.lastFrameByJid.set(chatInfo.jid, { headers: frame.headers });

    const timestamp = toIsoTimestamp(body.create_time);
    const senderId = body.from.userid;
    const senderName = senderId;
    const chatName = chatInfo.isGroup ? chatInfo.targetId : senderName;

    this.opts.onChatMetadata(
      chatInfo.jid,
      timestamp,
      chatName,
      'wecom',
      chatInfo.isGroup,
    );

    if (!this.opts.registeredGroups()[chatInfo.jid]) {
      logger.debug(
        { chatJid: chatInfo.jid },
        'Message from unregistered WeCom chat',
      );
      return;
    }

    // Download images based on message type
    let imageLocalPath: string | undefined;
    let mixedImagePaths: Map<number, string> | undefined;

    if (body.msgtype === 'image') {
      const imageBody = body as ImageMessage;
      imageLocalPath = await this.downloadImage(
        imageBody.image?.url,
        imageBody.image?.aeskey,
      );
    } else if (body.msgtype === 'mixed') {
      mixedImagePaths = await this.downloadMixedImages(body as MixedMessage);
    }

    const content = withQuote(
      buildContent(body, imageLocalPath, mixedImagePaths),
      body.quote,
    ).trim();

    if (!content) return;

    this.opts.onMessage(chatInfo.jid, {
      id: body.msgid,
      chat_jid: chatInfo.jid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const targetId = parseTargetJid(jid);
    if (!targetId) {
      throw new Error(`Invalid WeCom JID: ${jid}`);
    }
    if (!this.client) {
      throw new Error('WeCom client is not connected');
    }

    await this.client.sendMessage(targetId, {
      msgtype: 'markdown',
      markdown: { content: text },
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wc:user:') || jid.startsWith('wc:group:');
  }

  /**
   * Create a streaming session for the given JID.
   *
   * Uses the WeCom `replyStream` API which updates a single message in-place.
   * Requires a stored inbound frame (the req_id is needed for the reply
   * channel). Returns null when no frame is available (e.g. scheduled tasks)
   * — callers should fall back to `sendMessage`.
   *
   * If content exceeds WeCom's 20 480-byte limit, the stream is automatically
   * finished with the portion that fits and the overflow is sent as a separate
   * markdown message via `sendMessage`.
   */
  createStream(jid: string): StreamSession | null {
    if (!this.client) return null;

    const frame = this.lastFrameByJid.get(jid);
    if (!frame) return null;

    const streamId = generateReqId('stream');
    const client = this.client;
    let finished = false;

    logger.debug({ jid, streamId }, 'WeCom stream created');

    const sendChunk = async (text: string, finish: boolean): Promise<void> => {
      if (finished) {
        logger.warn({ jid, streamId }, 'WeCom stream already finished');
        return;
      }

      const bytes = Buffer.byteLength(text, 'utf8');

      if (bytes <= STREAM_MAX_BYTES) {
        await client.replyStream(frame, streamId, text, finish);
        if (finish) finished = true;
        return;
      }

      // Content exceeds the stream limit: truncate to the last full character
      // boundary that fits, finish the stream, then send the full text as a
      // standalone markdown message so nothing is lost.
      let truncated = text;
      while (Buffer.byteLength(truncated, 'utf8') > STREAM_MAX_BYTES) {
        truncated = truncated.slice(0, -100);
      }

      await client.replyStream(frame, streamId, truncated, true);
      finished = true;

      // Send full content as a follow-up message
      const targetId = parseTargetJid(jid);
      if (targetId) {
        await client.sendMessage(targetId, {
          msgtype: 'markdown',
          markdown: { content: text },
        });
      }
    };

    return {
      update: (text: string) => sendChunk(text, false),
      finish: (text: string) => sendChunk(text, true),
    };
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }
}

registerChannel('wecom', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WECOM_BOT_ID', 'WECOM_BOT_SECRET']);
  const botId = process.env.WECOM_BOT_ID || envVars.WECOM_BOT_ID || '';
  const secret = process.env.WECOM_BOT_SECRET || envVars.WECOM_BOT_SECRET || '';

  if (!botId || !secret) {
    logger.warn('WeCom: WECOM_BOT_ID or WECOM_BOT_SECRET not set');
    return null;
  }

  return new WecomChannel(opts, botId, secret);
});
