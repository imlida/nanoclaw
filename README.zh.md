# nanoclaw-add-wecom-skill

为 [NanoClaw](https://github.com/qwibitai/nanoclaw) 增加企业微信（WeCom）消息通道。

这个 skill 按照 NanoClaw 的通道架构来设计，目标是做成一个可以单独发布到 GitHub 的技能包，而不是把企业微信逻辑硬塞进 core。

## 它会增加什么

- `src/channels/wecom.ts`
- `src/channels/wecom.test.ts`
- 在 `src/channels/index.ts` 中追加 `import './wecom.js'`
- 安装 `@wecom/aibot-node-sdk`
- 增加环境变量 `WECOM_BOT_ID` 和 `WECOM_BOT_SECRET`

## 当前实现范围

这一版优先保证文本链路可靠：

- 文本消息
- 企业微信已转文字的语音消息
- 图文混排里的文本提取
- 图片/文件消息占位文本
- 向企业微信发送 Markdown 消息

它没有把媒体下载、卡片交互之类能力强行塞进 NanoClaw core，因为 NanoClaw 当前的 channel 抽象本身仍然以文本为中心。

## 安装

```bash
npx skills add <你的 GitHub 用户名>/nanoclaw-add-wecom-skill
```

然后在 Claude Code 里运行：

```text
/add-wecom
```

## 环境变量

```bash
WECOM_BOT_ID=你的机器人ID
WECOM_BOT_SECRET=你的机器人Secret
```

## JID 设计

- 群聊：`wc:group:<chatid>`
- 单聊：`wc:user:<userid>`

## 说明

- 群聊触发仍然走 NanoClaw 自己的触发逻辑。
- 第一版建议用户在企业微信群里直接发送显式触发词，例如 `@Andy ...`。
- 当前实现不假设企业微信的原生 @ 提及一定会完整映射到回调文本里；如果后续确认 payload 稳定，再补 mention 检测会更稳妥。
