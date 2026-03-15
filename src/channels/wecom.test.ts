import { beforeEach, describe, expect, it, vi } from 'vitest';

const wecomMocks = vi.hoisted(() => {
  class MockWSClient {
    static instances: MockWSClient[] = [];

    sendMessage = vi.fn(async () => ({}));
    replyStream = vi.fn(async () => ({}));
    disconnect = vi.fn();
    private handlers = new Map<string, Array<(payload?: unknown) => void>>();

    constructor(public options: Record<string, unknown>) {
      MockWSClient.instances.push(this);
    }

    on(event: string, handler: (payload?: unknown) => void): this {
      const existing = this.handlers.get(event) || [];
      existing.push(handler);
      this.handlers.set(event, existing);
      return this;
    }

    emit(event: string, payload?: unknown): void {
      for (const handler of this.handlers.get(event) || []) {
        handler(payload);
      }
    }

    connect(): this {
      queueMicrotask(() => this.emit('authenticated'));
      return this;
    }
  }

  let reqCounter = 0;
  return {
    MockWSClient,
    mockReadEnvFile: vi.fn(),
    mockGenerateReqId: vi.fn((prefix: string) => `${prefix}_${++reqCounter}`),
    mockLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('@wecom/aibot-node-sdk', () => ({
  default: {
    WSClient: wecomMocks.MockWSClient,
  },
  generateReqId: wecomMocks.mockGenerateReqId,
}));

vi.mock('../env.js', () => ({
  readEnvFile: wecomMocks.mockReadEnvFile,
}));

vi.mock('../logger.js', () => ({
  logger: wecomMocks.mockLogger,
}));

import { getChannelFactory } from './registry.js';
import './wecom.js';

describe('WecomChannel', () => {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups: Record<
    string,
    { name: string; folder: string; trigger: string; added_at: string }
  > = {};

  beforeEach(() => {
    wecomMocks.MockWSClient.instances = [];
    wecomMocks.mockReadEnvFile.mockReset();
    onMessage.mockReset();
    onChatMetadata.mockReset();
    wecomMocks.mockLogger.debug.mockReset();
    wecomMocks.mockLogger.info.mockReset();
    wecomMocks.mockLogger.warn.mockReset();
    wecomMocks.mockLogger.error.mockReset();
    for (const key of Object.keys(registeredGroups)) {
      delete registeredGroups[key];
    }
    delete process.env.WECOM_BOT_ID;
    delete process.env.WECOM_BOT_SECRET;
  });

  function createChannel() {
    const factory = getChannelFactory('wecom');
    expect(factory).toBeDefined();
    return factory!({
      onMessage,
      onChatMetadata,
      registeredGroups: () => registeredGroups,
    });
  }

  it('returns null when credentials are missing', () => {
    wecomMocks.mockReadEnvFile.mockReturnValue({});

    const channel = createChannel();

    expect(channel).toBeNull();
  });

  it('stores text messages for registered direct chats', async () => {
    wecomMocks.mockReadEnvFile.mockReturnValue({
      WECOM_BOT_ID: 'bot-id',
      WECOM_BOT_SECRET: 'bot-secret',
    });
    registeredGroups['wc:user:alice'] = {
      name: 'Alice',
      folder: 'wecom_main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    };

    const channel = createChannel();
    expect(channel).not.toBeNull();

    await channel!.connect();
    const client = wecomMocks.MockWSClient.instances[0];

    client.emit('message.text', {
      body: {
        msgid: 'm-1',
        msgtype: 'text',
        chattype: 'single',
        from: { userid: 'alice' },
        create_time: 1710000000000,
        text: { content: '@Andy hello from wecom' },
      },
    });

    expect(onChatMetadata).toHaveBeenCalledWith(
      'wc:user:alice',
      expect.any(String),
      'alice',
      'wecom',
      false,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'wc:user:alice',
      expect.objectContaining({
        id: 'm-1',
        chat_jid: 'wc:user:alice',
        sender: 'alice',
        sender_name: 'alice',
        content: '@Andy hello from wecom',
      }),
    );
  });

  it('keeps metadata for unregistered group chats but does not store message content', async () => {
    wecomMocks.mockReadEnvFile.mockReturnValue({
      WECOM_BOT_ID: 'bot-id',
      WECOM_BOT_SECRET: 'bot-secret',
    });

    const channel = createChannel();
    expect(channel).not.toBeNull();

    await channel!.connect();
    const client = wecomMocks.MockWSClient.instances[0];

    client.emit('message.text', {
      body: {
        msgid: 'm-2',
        msgtype: 'text',
        chattype: 'group',
        chatid: 'group-1',
        from: { userid: 'bob' },
        create_time: 1710000000000,
        text: { content: 'plain group message' },
      },
    });

    expect(onChatMetadata).toHaveBeenCalledWith(
      'wc:group:group-1',
      expect.any(String),
      'group-1',
      'wecom',
      true,
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('extracts mixed content and quoted text', async () => {
    wecomMocks.mockReadEnvFile.mockReturnValue({
      WECOM_BOT_ID: 'bot-id',
      WECOM_BOT_SECRET: 'bot-secret',
    });
    registeredGroups['wc:group:group-2'] = {
      name: 'Group Two',
      folder: 'wecom_group-two',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    };

    const channel = createChannel();
    expect(channel).not.toBeNull();

    await channel!.connect();
    const client = wecomMocks.MockWSClient.instances[0];

    client.emit('message.mixed', {
      body: {
        msgid: 'm-3',
        msgtype: 'mixed',
        chattype: 'group',
        chatid: 'group-2',
        from: { userid: 'carol' },
        create_time: 1710000000000,
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: '@Andy summarize this' } },
            { msgtype: 'image', image: { url: 'https://example.com/img' } },
          ],
        },
        quote: {
          text: { content: 'earlier context' },
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'wc:group:group-2',
      expect.objectContaining({
        content:
          '@Andy summarize this\n[WeCom image attachment]\n\n[Quoted message]\nearlier context',
      }),
    );
  });

  it('sends outbound markdown to the resolved target id', async () => {
    wecomMocks.mockReadEnvFile.mockReturnValue({
      WECOM_BOT_ID: 'bot-id',
      WECOM_BOT_SECRET: 'bot-secret',
    });

    const channel = createChannel();
    expect(channel).not.toBeNull();

    await channel!.connect();
    const client = wecomMocks.MockWSClient.instances[0];

    await channel!.sendMessage('wc:group:group-9', 'hello world');

    expect(client.sendMessage).toHaveBeenCalledWith('group-9', {
      msgtype: 'markdown',
      markdown: { content: 'hello world' },
    });
  });

  it('owns only wc user and group jids', () => {
    wecomMocks.mockReadEnvFile.mockReturnValue({
      WECOM_BOT_ID: 'bot-id',
      WECOM_BOT_SECRET: 'bot-secret',
    });

    const channel = createChannel();
    expect(channel).not.toBeNull();

    expect(channel!.ownsJid('wc:user:alice')).toBe(true);
    expect(channel!.ownsJid('wc:group:team')).toBe(true);
    expect(channel!.ownsJid('tg:123')).toBe(false);
  });

  describe('createStream', () => {
    function setupStreamChannel() {
      wecomMocks.mockReadEnvFile.mockReturnValue({
        WECOM_BOT_ID: 'bot-id',
        WECOM_BOT_SECRET: 'bot-secret',
      });
      registeredGroups['wc:user:alice'] = {
        name: 'Alice',
        folder: 'wecom_main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      };
      return createChannel()!;
    }

    it('returns null when no inbound frame was received', async () => {
      const channel = setupStreamChannel();
      await channel.connect();

      // No message received yet — no stored frame
      const stream = channel.createStream!('wc:user:alice');
      expect(stream).toBeNull();
    });

    it('returns a StreamSession after an inbound frame is received', async () => {
      const channel = setupStreamChannel();
      await channel.connect();
      const client = wecomMocks.MockWSClient.instances[0];

      // Receive a message to store the frame
      client.emit('message.text', {
        headers: { req_id: 'req-42' },
        body: {
          msgid: 'm-10',
          msgtype: 'text',
          chattype: 'single',
          from: { userid: 'alice' },
          create_time: 1710000000000,
          text: { content: 'hi' },
        },
      });

      const stream = channel.createStream!('wc:user:alice');
      expect(stream).not.toBeNull();
      expect(stream).toHaveProperty('update');
      expect(stream).toHaveProperty('finish');
    });

    it('calls replyStream with finish=false on update and finish=true on finish', async () => {
      const channel = setupStreamChannel();
      await channel.connect();
      const client = wecomMocks.MockWSClient.instances[0];

      client.emit('message.text', {
        headers: { req_id: 'req-42' },
        body: {
          msgid: 'm-10',
          msgtype: 'text',
          chattype: 'single',
          from: { userid: 'alice' },
          create_time: 1710000000000,
          text: { content: 'hi' },
        },
      });

      const stream = channel.createStream!('wc:user:alice')!;

      await stream.update('part 1');
      expect(client.replyStream).toHaveBeenCalledWith(
        { headers: { req_id: 'req-42' } },
        expect.any(String),
        'part 1',
        false,
      );

      await stream.finish('part 1\n\npart 2');
      expect(client.replyStream).toHaveBeenLastCalledWith(
        { headers: { req_id: 'req-42' } },
        expect.any(String),
        'part 1\n\npart 2',
        true,
      );
    });

    it('ignores calls after the stream has been finished', async () => {
      const channel = setupStreamChannel();
      await channel.connect();
      const client = wecomMocks.MockWSClient.instances[0];

      client.emit('message.text', {
        headers: { req_id: 'req-42' },
        body: {
          msgid: 'm-10',
          msgtype: 'text',
          chattype: 'single',
          from: { userid: 'alice' },
          create_time: 1710000000000,
          text: { content: 'hi' },
        },
      });

      const stream = channel.createStream!('wc:user:alice')!;

      await stream.finish('done');
      client.replyStream.mockClear();

      await stream.update('should be ignored');
      expect(client.replyStream).not.toHaveBeenCalled();
    });

    it('falls back to sendMessage when content exceeds stream byte limit', async () => {
      const channel = setupStreamChannel();
      await channel.connect();
      const client = wecomMocks.MockWSClient.instances[0];

      client.emit('message.text', {
        headers: { req_id: 'req-42' },
        body: {
          msgid: 'm-10',
          msgtype: 'text',
          chattype: 'single',
          from: { userid: 'alice' },
          create_time: 1710000000000,
          text: { content: 'hi' },
        },
      });

      const stream = channel.createStream!('wc:user:alice')!;

      // Create text that exceeds 20480 bytes
      const bigText = 'A'.repeat(21000);
      await stream.update(bigText);

      // Should have finished the stream with a truncated version
      expect(client.replyStream).toHaveBeenCalledWith(
        { headers: { req_id: 'req-42' } },
        expect.any(String),
        expect.any(String),
        true,  // auto-finished
      );

      // Should have sent a follow-up markdown message with full text
      expect(client.sendMessage).toHaveBeenCalledWith('alice', {
        msgtype: 'markdown',
        markdown: { content: bigText },
      });
    });
  });
});
