---
name: add-wecom
description: Add WeCom as a channel. Uses the WeCom AI Bot WebSocket SDK and works without public webhooks.
---

# Add WeCom Channel

This skill adds WeCom support to NanoClaw as a text-first messaging channel.

## Phase 1: Pre-flight

### Check if already applied

If `src/channels/wecom.ts` already exists, skip to Phase 3.

### Ask the user

Ask the user whether they already have a WeCom AI Bot `botId` and `secret`.

If they do, collect both now. If not, guide them through bot creation in Phase 3.

## Phase 2: Apply Code Changes

Apply the skill package from this repository:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-wecom
```

If the project uses the external skill installer instead, install this repository first and then apply `/add-wecom`.

This skill adds:

- `src/channels/wecom.ts`
- `src/channels/wecom.test.ts`
- `import './wecom.js'` in `src/channels/index.ts`
- `@wecom/aibot-node-sdk`
- `WECOM_BOT_ID`
- `WECOM_BOT_SECRET`

### Validate code changes

```bash
npm install
npm test
npm run build
```

All tests and the build must pass before setup continues.

## Phase 3: Setup

### Create the WeCom AI Bot if needed

If the user does not already have credentials, tell them:

1. Open the WeCom AI Bot management console
2. Create a bot
3. Copy the bot ID
4. Copy the bot secret
5. Ensure the bot is allowed to connect through the official WebSocket channel

Wait for the user to provide both values.

### Configure environment

Add to `.env`:

```bash
WECOM_BOT_ID=your_bot_id
WECOM_BOT_SECRET=your_bot_secret
```

Sync environment into NanoClaw's container-readable copy:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux users should restart their user service instead.

## Phase 4: Registration

### Discover the chat JID

Tell the user:

1. Send a message to the WeCom bot from the target chat
2. Watch `logs/nanoclaw.log`
3. Look for the unregistered WeCom chat log entry

JID format:

- direct chat: `wc:user:<userid>`
- group chat: `wc:group:<chatid>`

### Register the chat

For a main chat:

```typescript
registerGroup("wc:user:<userid>", {
  name: "<chat-name>",
  folder: "wecom_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For a group chat:

```typescript
registerGroup("wc:group:<chatid>", {
  name: "<group-name>",
  folder: "wecom_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

Tell the user to send a message in the registered WeCom chat.

- Main chat: any message
- Group chat: use explicit trigger text such as `@Andy hello`

If there is a problem, inspect:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not connecting

Check:

1. `WECOM_BOT_ID` and `WECOM_BOT_SECRET` exist in `.env`
2. `.env` has been synced into `data/env/env`
3. The WeCom bot credentials are correct
4. NanoClaw was restarted after the change

### Messages arrive but the bot does not respond

Check:

1. The chat was registered in SQLite
2. Group chats still require trigger text by default
3. The JID matches the correct format:
   - `wc:user:<userid>`
   - `wc:group:<chatid>`

### Native @mentions in group chats

This first version does not assume that WeCom mention metadata is always preserved in a stable, parseable way. Use explicit trigger text in groups unless you later verify the payload shape in your own tenant.

## Removal

To remove WeCom integration:

1. Delete `src/channels/wecom.ts`
2. Delete `src/channels/wecom.test.ts`
3. Remove `import './wecom.js'` from `src/channels/index.ts`
4. Remove `WECOM_BOT_ID` and `WECOM_BOT_SECRET` from `.env`
5. Remove WeCom registrations from SQLite:

```bash
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'wc:%'"
```
