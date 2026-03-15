import AiBot, {
  type BaseMessage,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type VoiceMessage,
  type WsFrame,
} from '@wecom/aibot-node-sdk';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

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

function extractMixedText(body: MixedMessage): string {
  const parts: string[] = [];
  for (const item of body.mixed?.msg_item || []) {
    if (item.msgtype === 'text' && item.text?.content) {
      parts.push(item.text.content.trim());
    } else if (item.msgtype === 'image') {
      parts.push('[WeCom image attachment]');
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}

function buildContent(body: BaseMessage): string {
  switch (body.msgtype) {
    case 'text':
      return body.text?.content?.trim() || '';
    case 'voice':
      return body.voice?.content?.trim() || '[WeCom voice message]';
    case 'mixed':
      return extractMixedText(body as MixedMessage);
    case 'image':
      return '[WeCom image attachment]';
    case 'file':
      return '[WeCom file attachment]';
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
    client.on('message.text', (frame: WecomFrame) => this.handleFrame(frame));
    client.on('message.voice', (frame: WecomFrame) => this.handleFrame(frame));
    client.on('message.mixed', (frame: WecomFrame) => this.handleFrame(frame));
    client.on('message.image', (frame: WecomFrame) => this.handleFrame(frame));
    client.on('message.file', (frame: WecomFrame) => this.handleFrame(frame));
  }

  private handleFrame(frame: WecomFrame): void {
    const body = frame.body;
    if (!body?.msgid || !body.from?.userid) return;

    const chatInfo = toChatJid(body);
    if (!chatInfo) return;

    const timestamp = toIsoTimestamp(body.create_time);
    const senderId = body.from.userid;
    const senderName = senderId;
    const chatName = chatInfo.isGroup ? chatInfo.targetId : senderName;
    const content = withQuote(buildContent(body), body.quote).trim();

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
