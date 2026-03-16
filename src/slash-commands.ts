import { ASSISTANT_NAME } from './config.js';
import { deleteSession } from './db.js';
import { logger } from './logger.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';
import type { GroupQueue } from './group-queue.js';

/** Known slash commands that should be intercepted before reaching the LLM. */
const KNOWN_COMMANDS = new Set([
  '/clear',
  '/help',
  '/status',
  '/compact',
]);

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
    case '/compact':
      response = '`/compact` is handled automatically by the agent session. No manual action needed.';
      break;
    default:
      response = `Unknown command: \`${cmd}\`. Type \`/help\` to see available commands.`;
  }

  try {
    await channel.sendMessage(chatJid, response);
  } catch (err) {
    logger.error({ chatJid, cmd, err }, 'Failed to send slash command response');
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
    return 'Session cleared. The next message will start a fresh conversation.';
  }

  return 'No active session to clear.';
}

function executeHelp(): string {
  return [
    '**Available Commands**',
    '',
    '`/clear` - Clear conversation session and start fresh',
    '`/status` - Show current group and session status',
    '`/help` - Show this help message',
    '`/compact` - Session compaction info',
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
    '**Status**',
    '',
    `**Group:** ${group.name}`,
    `**Folder:** ${group.folder}`,
    `**Session:** ${hasSession ? 'Active' : 'None'}`,
    `**Trigger required:** ${group.requiresTrigger !== false ? 'Yes' : 'No'}`,
    `**Main group:** ${group.isMain ? 'Yes' : 'No'}`,
    `**Assistant:** ${ASSISTANT_NAME}`,
  ];

  return lines.join('\n');
}

