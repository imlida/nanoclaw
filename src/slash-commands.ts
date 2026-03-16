import { ASSISTANT_NAME } from './config.js';
import { deleteSession } from './db.js';
import { logger } from './logger.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';
import type { GroupQueue } from './group-queue.js';

/** Known slash commands that should be intercepted before reaching the LLM. */
const KNOWN_COMMANDS = new Set(['/clear', '/help', '/status']);

export interface SlashCommandDeps {
  findChannel: (jid: string) => Channel | undefined;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sessions: () => Record<string, string>;
  clearSession: (groupFolder: string) => void;
  queue: GroupQueue;
}

/**
 * Check whether a message is a slash command that should be intercepted.
 * Returns true if the message was handled (caller should not process further).
 */
export function isSlashCommand(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return false;
  const cmd = trimmed.split(/\s+/)[0].toLowerCase();
  return KNOWN_COMMANDS.has(cmd);
}

/**
 * Handle an intercepted slash command.
 * Sends the result directly to the user via the channel.
 */
export async function handleSlashCommand(
  content: string,
  chatJid: string,
  msg: NewMessage,
  deps: SlashCommandDeps,
): Promise<void> {
  const trimmed = content.trim();
  const cmd = trimmed.split(/\s+/)[0].toLowerCase();

  const channel = deps.findChannel(chatJid);
  if (!channel) {
    logger.warn({ chatJid, cmd }, 'No channel for slash command response');
    return;
  }

  const group = deps.registeredGroups()[chatJid];
  if (!group) {
    logger.warn({ chatJid, cmd }, 'Slash command from unregistered group');
    return;
  }

  logger.info(
    { chatJid, cmd, sender: msg.sender, group: group.name },
    'Handling slash command',
  );

  let response: string;

  switch (cmd) {
    case '/clear':
      response = executeClear(group, chatJid, deps);
      break;
    case '/help':
      response = executeHelp();
      break;
    case '/status':
      response = executeStatus(group, chatJid, deps);
      break;
    default:
      response = `未知命令: \`${cmd}\`。输入 \`/help\` 查看可用命令。`;
  }

  try {
    await channel.sendMessage(chatJid, response);
  } catch (err) {
    logger.error(
      { chatJid, cmd, err },
      'Failed to send slash command response',
    );
  }
}

function executeClear(
  group: RegisteredGroup,
  chatJid: string,
  deps: SlashCommandDeps,
): string {
  const sessions = deps.sessions();
  const hadSession = !!sessions[group.folder];

  if (hadSession) {
    // Clear from in-memory map and DB
    deps.clearSession(group.folder);
    // Close the active container if one is running
    deps.queue.closeStdin(chatJid);
    return '会话已清除。下一条消息将开始全新对话。';
  }

  return '没有活动会话需要清除。';
}

function executeHelp(): string {
  return [
    '**可用命令**',
    '',
    '`/clear` - 清除对话会话，重新开始',
    '`/status` - 显示当前群组和会话状态',
    '`/help` - 显示此帮助信息',
  ].join('\n');
}

function executeStatus(
  group: RegisteredGroup,
  chatJid: string,
  deps: SlashCommandDeps,
): string {
  const sessions = deps.sessions();
  const hasSession = !!sessions[group.folder];

  const lines = [
    '**状态**',
    '',
    `**群组:** ${group.name}`,
    `**文件夹:** ${group.folder}`,
    `**会话:** ${hasSession ? '活跃' : '无'}`,
    `**需要触发词:** ${group.requiresTrigger !== false ? '是' : '否'}`,
    `**主群组:** ${group.isMain ? '是' : '否'}`,
    `**助手:** ${ASSISTANT_NAME}`,
  ];

  return lines.join('\n');
}
