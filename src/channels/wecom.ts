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

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel, StreamSession } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

/** Maximum content size for a single replyStream call (WeCom limit: 20480 bytes). */
const STREAM_MAX_BYTES = 20480;

/** Cooldown period after hitting rate limit (errcode 846607). */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Check if an error is a WeCom rate limit error (846607). */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  return (
    obj.errcode === 846607 ||
    (typeof obj.errmsg === 'string' &&
      obj.errmsg.includes('frequency limit exceeded'))
  );
}

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

/** Convert a host-local path to a container-accessible path. */
function toContainerPath(localPath: string): string {
  return `/workspace/wecom-media/${path.basename(localPath)}`;
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
    return `![WeCom Image](${toContainerPath(localPath)})`;
  }
  if (image?.url) {
    // Fallback: include URL info (note: encrypted, 5-min expiry)
    return `[WeCom image: ${image.url.substring(0, 80)}...]`;
  }
  return '[WeCom image attachment]';
}

/**
 * Format file information for inclusion in message content.
 * Returns a Markdown-style link with the local file path if available.
 */
function formatFileInfo(localPath?: string, originalFilename?: string): string {
  if (localPath) {
    const displayName = originalFilename || path.basename(localPath);
    return `[WeCom File: ${displayName}](${toContainerPath(localPath)})`;
  }
  return '[WeCom file attachment]';
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
  fileInfo?: { localPath: string; originalFilename?: string },
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
    case 'file':
      return formatFileInfo(fileInfo?.localPath, fileInfo?.originalFilename);
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
  /** Timestamp when rate limit cooldown expires (0 = not rate limited). */
  private rateLimitUntil = 0;

  constructor(
    private opts: ChannelOpts,
    private botId: string,
    private secret: string,
  ) {}

  /**
   * Check if currently rate limited. If so, throw a descriptive error
   * instead of hitting the API again.
   */
  private checkRateLimit(): void {
    if (this.rateLimitUntil > Date.now()) {
      const remainMs = this.rateLimitUntil - Date.now();
      throw new Error(
        `WeCom rate limited, cooling down for ${Math.ceil(remainMs / 1000)}s`,
      );
    }
  }

  /**
   * Mark the channel as rate limited after receiving errcode 846607.
   */
  private onRateLimited(err: unknown): void {
    this.rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    logger.warn(
      { cooldownMs: RATE_LIMIT_COOLDOWN_MS, err },
      'WeCom rate limit hit (846607), pausing sends',
    );
  }

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
   * Download a file from WeCom and save it locally.
   * Returns the local file path on success, undefined on failure.
   */
  private async downloadMedia(
    url: string,
    aeskey?: string,
    defaultExt: string = 'jpg',
  ): Promise<{ localPath: string; originalFilename?: string } | undefined> {
    if (!this.client || !url) return undefined;

    try {
      ensureMediaDir();
      const { buffer, filename } = await this.client.downloadFile(url, aeskey);

      const ext = filename
        ? path.extname(filename).slice(1) || defaultExt
        : defaultExt;
      const localFilename = generateMediaFilename(ext);
      const localPath = path.join(WECOM_MEDIA_DIR, localFilename);

      fs.writeFileSync(localPath, buffer);
      logger.debug(
        { localPath, originalFilename: filename },
        'WeCom media downloaded',
      );

      return { localPath, originalFilename: filename };
    } catch (err) {
      logger.warn(
        { err, url: url.substring(0, 50) },
        'Failed to download WeCom media',
      );
      return undefined;
    }
  }

  /** Backwards-compatible helper for image downloads. */
  private async downloadImage(
    url: string,
    aeskey?: string,
  ): Promise<string | undefined> {
    const result = await this.downloadMedia(url, aeskey, 'jpg');
    return result?.localPath;
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

    // Download media based on message type
    let imageLocalPath: string | undefined;
    let mixedImagePaths: Map<number, string> | undefined;
    let fileInfo: { localPath: string; originalFilename?: string } | undefined;

    if (body.msgtype === 'image') {
      const imageBody = body as ImageMessage;
      imageLocalPath = await this.downloadImage(
        imageBody.image?.url,
        imageBody.image?.aeskey,
      );
    } else if (body.msgtype === 'mixed') {
      mixedImagePaths = await this.downloadMixedImages(body as MixedMessage);
    } else if (body.msgtype === 'file') {
      const fileBody = body as FileMessage;
      if (fileBody.file?.url) {
        const result = await this.downloadMedia(
          fileBody.file.url,
          fileBody.file.aeskey,
          'bin',
        );
        if (result) {
          fileInfo = {
            localPath: result.localPath,
            originalFilename: result.originalFilename,
          };
        }
      }
    }

    const content = withQuote(
      buildContent(body, imageLocalPath, mixedImagePaths, fileInfo),
      body.quote,
    ).trim();

    if (!content) return;

    // WeCom AI Bot SDK only delivers group messages that @ the bot.
    // Normalize so TRIGGER_PATTERN matches, same as Telegram channel.
    const normalizedContent =
      chatInfo.isGroup && !TRIGGER_PATTERN.test(content)
        ? `@${ASSISTANT_NAME} ${content}`
        : content;

    this.opts.onMessage(chatInfo.jid, {
      id: body.msgid,
      chat_jid: chatInfo.jid,
      sender: senderId,
      sender_name: senderName,
      content: normalizedContent,
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
    this.checkRateLimit();

    try {
      await this.client.sendMessage(targetId, {
        msgtype: 'markdown',
        markdown: { content: text },
      });
    } catch (err) {
      if (isRateLimitError(err)) {
        this.onRateLimited(err);
      }
      throw err;
    }
  }

  async sendFile(jid: string, filePath: string): Promise<void> {
    const targetId = parseTargetJid(jid);
    if (!targetId) {
      throw new Error(`Invalid WeCom JID: ${jid}`);
    }
    if (!this.client) {
      throw new Error('WeCom client is not connected');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const ext = path.extname(filename).slice(1).toLowerCase();

    // Determine media type from extension
    const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);
    const mediaType: 'file' | 'image' = imageExts.has(ext) ? 'image' : 'file';

    logger.info(
      { jid, filePath, filename, mediaType, size: fileBuffer.length },
      'Uploading file to WeCom',
    );
    this.checkRateLimit();

    try {
      const result = await this.client.uploadMedia(fileBuffer, {
        type: mediaType,
        filename,
      });

      logger.info(
        { jid, mediaId: result.media_id, mediaType },
        'File uploaded, sending media message',
      );

      await this.client.sendMediaMessage(targetId, mediaType, result.media_id);
    } catch (err) {
      if (isRateLimitError(err)) {
        this.onRateLimited(err);
      }
      throw err;
    }
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

      // Skip if currently rate limited
      if (this.rateLimitUntil > Date.now()) {
        if (finish) finished = true;
        logger.debug({ jid, streamId }, 'Stream send skipped: rate limited');
        return;
      }

      try {
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
      } catch (err) {
        if (isRateLimitError(err)) {
          this.onRateLimited(err);
          if (finish) finished = true;
          return;
        }
        throw err;
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
