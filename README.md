# nanoclaw-add-wecom-skill

Add WeCom (Enterprise WeChat) as a messaging channel to [NanoClaw](https://github.com/qwibitai/nanoclaw).

This skill is designed as a standalone package that can be published to GitHub and installed with a skill installer. It follows NanoClaw's channel architecture instead of patching core behavior in ad hoc ways.

## What it adds

- `src/channels/wecom.ts`
- `src/channels/wecom.test.ts`
- `import './wecom.js'` in `src/channels/index.ts`
- `@wecom/aibot-node-sdk` dependency
- `WECOM_BOT_ID` and `WECOM_BOT_SECRET` environment variables

## Current scope

The channel focuses on reliable text-first support:

- text messages
- voice messages converted to text by the WeCom platform
- mixed messages with text extraction
- image/file placeholders so the conversation stays coherent
- outbound markdown messages

It does not try to add media download or card interactions to NanoClaw core, because NanoClaw's current channel abstraction is still text-oriented.

## Install

```bash
npx skills add <your-github-user>/nanoclaw-add-wecom-skill
```

Then run:

```text
/add-wecom
```

## Environment variables

```bash
WECOM_BOT_ID=your_bot_id
WECOM_BOT_SECRET=your_bot_secret
```

## JID format

- Group chat: `wc:group:<chatid>`
- Direct chat: `wc:user:<userid>`

## Notes

- Group chat triggering is still controlled by NanoClaw's normal trigger logic.
- For the first version, users should send explicit trigger text such as `@Andy ...` in WeCom groups.
- WeCom native @mention detection is intentionally not assumed unless verified from the callback payload.
