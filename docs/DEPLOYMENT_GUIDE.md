# NanoClaw 完整部署教程

> 从零开始部署您的专属 Claude 助手

## 目录

1. [概述与环境要求](#1-概述与环境要求)
2. [前期准备](#2-前期准备)
3. [项目初始化](#3-项目初始化)
4. [容器运行时配置](#4-容器运行时配置)
5. [Claude 认证配置](#5-claude-认证配置)
6. [消息通道配置](#6-消息通道配置)
7. [服务配置与启动](#7-服务配置与启动)
8. [平台差异化配置详解](#8-平台差异化配置详解)
9. [常见问题排查指南](#9-常见问题排查指南)
10. [Docker Sandbox 部署（可选高级）](#10-docker-sandbox-部署可选高级)

---

## 1. 概述与环境要求

### 1.1 NanoClaw 简介

NanoClaw 是一个轻量级的 Claude 助手平台，它将 AI 智能体运行在具有文件系统隔离的 Linux 容器中（而非依赖应用级权限检查）。主要特点包括：

- **小巧易懂**：单一 Node.js 进程，少量源文件，无微服务架构
- **通过隔离保障安全**：智能体运行在容器沙箱中，只能访问明确挂载的目录
- **多渠道消息**：支持 WhatsApp、Telegram、Discord、Slack、企业微信(WeCom) 等
- **AI 原生**：通过 Claude Code 进行安装、配置和故障排查
- **智能体集群**：支持多个专业智能体团队协作完成任务

### 1.2 系统要求

| 组件 | 要求 | 说明 |
|------|------|------|
| 操作系统 | macOS 或 Linux | Windows 可通过 WSL 运行 |
| Node.js | 20+ | 推荐使用 22 LTS |
| Git | 任意版本 | 用于代码管理 |
| 容器运行时 | Docker 或 Apple Container | Docker 跨平台，Apple Container 仅 macOS |
| Claude Code | 最新版 | 安装指南见下文 |

### 1.3 Claude Code 安装

Claude Code 是部署和管理 NanoClaw 的主要工具：

```bash
# 安装 Claude Code
npm install -g @anthropic-ai/claude-code

# 验证安装
claude --version
```

---

## 2. 前期准备

### 2.1 Node.js 环境安装

#### macOS

**方式一：使用 Homebrew（推荐）**

```bash
# 安装 Node.js 22
brew install node@22

# 添加到 PATH
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**方式二：使用 nvm（版本管理器）**

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重新加载 shell
source ~/.zshrc

# 安装并启用 Node.js 22
nvm install 22
nvm use 22
nvm alias default 22
```

#### Linux

**方式一：使用 NodeSource**

```bash
# 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证安装
node --version  # 应显示 v22.x.x
```

**方式二：使用 nvm**

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重新加载 shell
source ~/.bashrc  # 或 ~/.zshrc

# 安装并启用 Node.js 22
nvm install 22
nvm use 22
nvm alias default 22
```

#### 验证 Node.js 安装

```bash
node --version    # 应显示 v22.x.x
npm --version     # 应显示 10.x.x
```

### 2.2 容器运行时选择

NanoClaw 支持两种容器运行时，根据您的平台选择：

| 运行时 | 支持平台 | 特点 | 适用场景 |
|--------|----------|------|----------|
| **Docker Desktop** | macOS、Linux | 跨平台、生态成熟、图形界面 | 推荐初学者，多平台需求 |
| **Apple Container** | 仅 macOS | 原生轻量、启动更快、资源占用少 | macOS 用户追求性能 |

#### Docker Desktop 安装与验证

**macOS：**
```bash
# 使用 Homebrew 安装
brew install --cask docker

# 启动 Docker Desktop
open -a Docker

# 等待 Docker 完全启动（约 30 秒）
sleep 30

# 验证安装
docker --version
docker info
```

**Linux：**
```bash
# 安装 Docker
curl -fsSL https://get.docker.com | sh

# 将当前用户加入 docker 组（免 sudo 运行）
sudo usermod -aG docker $USER

# 重新登录以生效（或执行以下命令）
newgrp docker

# 验证安装
docker --version
docker info
```

#### Apple Container 安装与验证（macOS 专属）

```bash
# 安装 Apple Container
brew install apple/container/container

# 验证安装
container --version

# 启动容器运行时
container system start
```

### 2.3 Git 仓库设置

#### 为什么推荐 Fork？

虽然可以直接克隆仓库，但强烈建议先 Fork：

1. **保留自定义修改**：您可以自由修改代码而不影响上游
2. **便于更新**：可以同步上游更新同时保留自己的改动
3. **版本控制**：您的配置和定制都在自己的仓库中

#### 设置步骤

**步骤 1：在 GitHub 上 Fork 仓库**

1. 访问 https://github.com/qwibitai/nanoclaw
2. 点击右上角的 "Fork" 按钮
3. 选择您的个人账号作为目标

**步骤 2：克隆您的 Fork**

```bash
# 将 <your-username> 替换为您的 GitHub 用户名
git clone https://github.com/<your-username>/nanoclaw.git
cd nanoclaw
```

**步骤 3：配置 Upstream 远程仓库**

```bash
# 添加上游仓库（用于后续更新）
git remote add upstream https://github.com/qwibitai/nanoclaw.git

# 验证配置
git remote -v
# 应显示：
# origin    https://github.com/<your-username>/nanoclaw.git (fetch)
# origin    https://github.com/<your-username>/nanoclaw.git (push)
# upstream  https://github.com/qwibitai/nanoclaw.git (fetch)
# upstream  https://github.com/qwibitai/nanoclaw.git (push)
```

---

## 3. 项目初始化

### 3.1 运行自动设置脚本

NanoClaw 提供了自动化的设置脚本，会检查并安装必要的依赖：

```bash
# 在项目根目录执行
bash setup.sh
```

脚本会输出一个状态块，类似：

```
=== NanoClaw Setup Status ===
PLATFORM: macos|linux
NODE_OK: true|false
DEPS_OK: true|false
NATIVE_OK: true|false
==============================
```

#### 处理各种状态

| 状态 | 含义 | 解决方案 |
|------|------|----------|
| `NODE_OK=false` | Node.js 版本不符合要求（需要 20+） | 参考 2.1 节重新安装 Node.js |
| `DEPS_OK=false` | npm 依赖安装失败 | 删除 `node_modules` 后重试，`rm -rf node_modules && bash setup.sh` |
| `NATIVE_OK=false` | 原生模块（如 better-sqlite3）编译失败 | 安装编译工具：macOS 运行 `xcode-select --install`，Linux 运行 `sudo apt-get install -y build-essential` |

### 3.2 环境检查

设置脚本完成后，运行环境检查以了解系统状态：

```bash
npx tsx setup/index.ts --step environment
```

输出示例：

```
=== Environment Status ===
HAS_ENV: true|false          # 是否已有 .env 配置文件
HAS_AUTH: true|false         # 是否已配置通道认证（如 WhatsApp）
HAS_REGISTERED_GROUPS: true|false  # 是否已注册聊天群组
APPLE_CONTAINER: installed|not_found  # Apple Container 状态（macOS）
DOCKER: running|installed_not_running|not_found  # Docker 状态
==============================
```

记录这些状态，它们会影响后续步骤的选择。

---

## 4. 容器运行时配置

根据您选择的运行时，执行相应的配置步骤。

### 4.1 Docker 配置（跨平台）

#### 确保 Docker 正在运行

```bash
# 检查 Docker 状态
docker info

# 如果显示 "Cannot connect to the Docker daemon"
# macOS: 启动 Docker Desktop
open -a Docker

# Linux: 启动 Docker 服务
sudo systemctl start docker

# 等待 Docker 完全启动
sleep 15
```

#### 构建容器镜像

```bash
# 执行构建脚本
bash container/build.sh

# 验证镜像构建成功
docker images | grep nanoclaw-agent
# 应显示 nanoclaw-agent:latest
```

#### 测试容器运行时

```bash
# 运行容器测试
npx tsx setup/index.ts --step container -- --runtime docker

# 预期输出应显示 BUILD_OK: true 和 TEST_OK: true
```

### 4.2 Apple Container 配置（macOS 专属）

Apple Container 是 macOS 的原生容器运行时，比 Docker Desktop 更轻量。

#### 检查是否需要代码转换

如果您的代码是从 Docker 版本转换而来，需要检查是否已经转换：

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "已转换" || echo "需要转换"
```

如果显示"需要转换"，运行转换技能：

```bash
# 在 Claude Code 中执行
/convert-to-apple-container
```

#### 关键网络配置

**这是 Apple Container 与 Docker 最重要的差异！**

Apple Container 不支持 `host.docker.internal`，容器无法直接访问主机的 127.0.0.1。必须配置特殊的环境变量：

| 环境变量 | 值 | 作用 |
|----------|-----|------|
| `CREDENTIAL_PROXY_HOST` | `0.0.0.0` | 让凭证代理监听所有网络接口，容器才能访问 |
| `APPLE_CONTAINER_HOST` | `192.168.64.1` | Apple Container VM 的网关 IP，容器通过此地址访问主机 |

**配置步骤：**

1. **创建或编辑 launchd 配置文件**

```bash
# 创建 LaunchAgents 目录（如果不存在）
mkdir -p ~/Library/LaunchAgents

# 创建 plist 文件
cat > ~/Library/LaunchAgents/com.nanoclaw.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/USERNAME/nanoclaw/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/USERNAME/nanoclaw</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/Users/USERNAME/.local/bin</string>
        <key>HOME</key>
        <string>/Users/USERNAME</string>
        <key>CREDENTIAL_PROXY_HOST</key>
        <string>0.0.0.0</string>
        <key>APPLE_CONTAINER_HOST</key>
        <string>192.168.64.1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/USERNAME/nanoclaw/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/nanoclaw/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF
```

**重要：** 将上面文件中的 `USERNAME` 替换为您的实际用户名（使用 `whoami` 查看）。

2. **验证 plist 格式**

```bash
plutil -lint ~/Library/LaunchAgents/com.nanoclaw.plist
# 应显示: ~/Library/LaunchAgents/com.nanoclaw.plist: OK
```

3. **创建日志目录**

```bash
mkdir -p ~/nanoclaw/logs
```

#### 构建容器镜像

```bash
# 确保 Apple Container 正在运行
container system start

# 执行构建
bash container/build.sh

# 验证镜像
container images | grep nanoclaw-agent
```

#### 测试网络连通性（关键步骤）

在启动服务前，必须验证容器可以访问主机的凭证代理：

```bash
# 测试容器到主机的连通性
echo '{}' | container run -i --rm --entrypoint /bin/bash nanoclaw-agent:latest \
  -c "curl -s http://192.168.64.1:3001/v1/models -H 'Authorization: Bearer test'"

# 预期输出应包含模型列表，例如：
# {"data":[{"id":"claude-3-opus-20240229",...}]}
```

如果显示 "Connection refused" 或 "Connection timeout"，检查：

1. `CREDENTIAL_PROXY_HOST` 是否设置为 `0.0.0.0`
2. 环境变量是否正确加载：`launchctl getenv CREDENTIAL_PROXY_HOST`
3. 凭证代理是否正在运行：`lsof -i :3001`

---

## 5. Claude 认证配置

NanoClaw 支持两种 Claude 认证方式：

| 方式 | 适用场景 | 配置方法 |
|------|----------|----------|
| **Claude Pro/Max 订阅** | 已有 Claude 订阅的用户 | OAuth Token |
| **Anthropic API Key** | 开发者或需要 API 访问 | API Key |

### 5.1 使用 Claude Pro/Max 订阅（OAuth Token）

1. **获取 OAuth Token**

```bash
# 在另一个终端运行
claude setup-token
# 复制输出的 token
```

2. **配置环境变量**

```bash
# 编辑 .env 文件
cat > .env << 'EOF'
CLAUDE_CODE_OAUTH_TOKEN=your_oauth_token_here
ASSISTANT_NAME=nanoclaw
EOF
```

### 5.2 使用 Anthropic API Key

1. **获取 API Key**

   访问 https://console.anthropic.com/ 创建 API Key。

2. **配置环境变量**

```bash
cat > .env << 'EOF'
ANTHROPIC_API_KEY=your_api_key_here
ASSISTANT_NAME=nanoclaw
EOF
```

### 5.3 同步环境变量到容器

```bash
# 创建目录并复制环境变量
mkdir -p data/env
cp .env data/env/env
```

### 5.4 凭证代理工作原理

NanoClaw 使用凭证代理来安全地管理 Claude 认证：

```
容器内 Agent → 凭证代理 (主机:3001) → Anthropic API
                    ↑
              管理认证令牌
```

- 凭证代理运行在主机上，监听 3001 端口
- 容器内的请求通过代理转发到 Anthropic API
- 代理负责添加认证信息，容器无需直接访问密钥

---

## 6. 消息通道配置

NanoClaw 通过"技能"（Skills）添加消息通道。以下是 WeCom（企业微信）的详细配置步骤，其他通道类似。

### 6.1 WeCom（企业微信）通道配置

WeCom 通道使用 WebSocket 连接，不需要公网 Webhook。

#### Phase 1: 安装 WeCom 技能

```bash
# 应用 WeCom 技能
npx tsx scripts/apply-skill.ts .claude/skills/add-wecom

# 安装新增依赖
npm install

# 构建项目
npm run build

# 运行测试确保无错误
npm test
```

安装完成后，会新增以下文件：
- `src/channels/wecom.ts` - WeCom 通道主代码
- `src/channels/wecom.test.ts` - 测试文件

#### Phase 2: 创建 WeCom AI Bot

1. **登录 WeCom 管理后台**
   - 访问 https://work.weixin.qq.com/wework_admin
   - 使用管理员账号登录

2. **创建 AI Bot**
   - 进入"应用管理"
   - 找到"AI 助手"或创建新应用
   - 启用 AI Bot 功能

3. **获取凭证信息**
   - 记录 **Bot ID**（格式类似 `wwxxxxxxxxxxxxxxxx`）
   - 记录 **Secret**（仅显示一次，请妥善保存）

4. **配置网络权限**
   - 确保 Bot 可以通过 WebSocket 连接到官方服务器
   - 如果使用代理，需要配置代理白名单

#### Phase 3: 配置环境变量

```bash
# 编辑 .env 文件，添加 WeCom 配置
cat >> .env << 'EOF'
WECOM_BOT_ID=your_bot_id_here
WECOM_BOT_SECRET=your_bot_secret_here
EOF

# 同步到容器可读位置
mkdir -p data/env
cp .env data/env/env
```

#### Phase 4: 发现与注册聊天

**发现 JID（聊天标识符）：**

1. **启动 NanoClaw 服务**（见第 7 节）

2. **从 WeCom 发送消息给 Bot**
   - 私聊：直接在企业微信中找到 Bot 并发送消息
   - 群聊：将 Bot 加入群聊后在群内发送消息

3. **查看日志发现 JID**

```bash
# 查看 NanoClaw 日志
tail -f logs/nanoclaw.log

# 寻找类似以下的日志条目：
# [WeCom] Unregistered chat: wc:user:USERID
# [WeCom] Unregistered chat: wc:group:GROUPID
```

**JID 格式说明：**

| 聊天类型 | JID 格式 | 示例 |
|----------|----------|------|
| 私聊 | `wc:user:<userid>` | `wc:user:ZhangSan` |
| 群聊 | `wc:group:<chatid>` | `wc:group:wrcgxxxxxxxx` |

**注册聊天：**

创建一个注册脚本 `register-wecom.ts`：

```typescript
import { registerGroup } from './src/db.js';

const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'nanoclaw';

// 注册私聊（主频道示例）
registerGroup("wc:user:YOUR_USER_ID", {
  name: "我的私聊",
  folder: "wecom_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,  // 私聊不需要触发词
  isMain: true,
});

// 注册群聊
registerGroup("wc:group:YOUR_GROUP_ID", {
  name: "工作群",
  folder: "wecom_workgroup",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,   // 群聊需要触发词
});

console.log('WeCom 聊天注册完成');
```

执行注册：

```bash
npx tsx register-wecom.ts
```

#### Phase 5: 验证配置

1. **发送测试消息**
   - 私聊：直接发送任意消息
   - 群聊：发送 `@nanoclaw 你好`

2. **查看响应**

```bash
# 实时监控日志
tail -f logs/nanoclaw.log

# 预期看到：
# - 消息接收日志
# - 容器启动日志
# - AI 响应日志
```

### 6.2 其他消息通道

#### WhatsApp

```bash
# 应用技能
npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp
npm install && npm run build

# 认证（QR 码方式）
npx tsx src/whatsapp-auth.ts
# 扫描显示的 QR 码

# 或使用配对码
npx tsx src/whatsapp-auth.ts --pairing-code --phone 86138xxxxxxxx
```

#### Telegram

```bash
# 应用技能
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram
npm install && npm run build

# 配置 Bot Token（从 @BotFather 获取）
echo "TELEGRAM_BOT_TOKEN=your_token" >> .env
mkdir -p data/env && cp .env data/env/env
```

#### 其他通道

- **Slack**: `/add-slack`
- **Discord**: `/add-discord`
- **Gmail**: `/add-gmail`

---

## 7. 服务配置与启动

### 7.1 服务配置

#### macOS (launchd)

如果之前已创建 `~/Library/LaunchAgents/com.nanoclaw.plist`，直接加载：

```bash
# 如果服务已在运行，先卸载
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null

# 加载服务
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**手动创建 plist 文件（如果尚未创建）：**

```bash
mkdir -p ~/Library/LaunchAgents

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>$(pwd)/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$(pwd)/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>$(pwd)/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

# 注意：将 $(pwd) 替换为实际路径，$(which node) 替换为实际 Node 路径
```

#### Linux (systemd)

创建用户服务文件：

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/nanoclaw.service << 'EOF'
[Unit]
Description=NanoClaw AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/USERNAME/nanoclaw
ExecStart=/usr/bin/node /home/USERNAME/nanoclaw/dist/index.js
Restart=always
RestartSec=10
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
EOF

# 替换 USERNAME 为您的用户名

# 重新加载 systemd
systemctl --user daemon-reload

# 启动服务
systemctl --user start nanoclaw

# 设置开机自启
systemctl --user enable nanoclaw
```

#### WSL (无 systemd)

如果 WSL 没有启用 systemd，使用以下方式：

```bash
# 创建启动脚本
cat > start-nanoclaw.sh << 'EOF'
#!/bin/bash
cd /home/USERNAME/nanoclaw
nohup node dist/index.js > logs/nanoclaw.log 2> logs/nanoclaw.error.log &
echo $! > nanoclaw.pid
echo "NanoClaw started with PID $(cat nanoclaw.pid)"
EOF

chmod +x start-nanoclaw.sh

# 启动
./start-nanoclaw.sh
```

### 7.2 启动服务

#### macOS

```bash
# 启动（或重启）
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 或完全重新加载
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

#### Linux

```bash
# 启动
systemctl --user start nanoclaw

# 重启
systemctl --user restart nanoclaw

# 查看状态
systemctl --user status nanoclaw
```

### 7.3 验证服务状态

```bash
npx tsx setup/index.ts --step verify
```

预期输出示例：

```
=== Verification Status ===
SERVICE: running|stopped|not_found
CREDENTIALS: ok|missing
CHANNEL_AUTH:
  wecom: ok|not_found
  whatsapp: ok|not_found
REGISTERED_GROUPS: 2
MOUNT_ALLOWLIST: ok|missing
==============================
```

#### 查看日志

```bash
# 主日志
tail -f logs/nanoclaw.log

# 错误日志
tail -f logs/nanoclaw.error.log

# 容器日志（macOS）
tail -f groups/main/logs/container-*.log
```

---

## 8. 平台差异化配置详解

### 8.1 macOS 配置要点

#### Apple Container 特殊配置

**网络架构：**

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   容器内 Agent   │────▶│  192.168.64.1    │────▶│  主机凭证代理    │
│                 │     │  :3001           │     │  0.0.0.0:3001   │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                               ┌───────────────────────────┘
                               ▼
                     ┌──────────────────┐
                     │  api.anthropic.com
                     └──────────────────┘
```

**关键配置清单：**

1. **plist 必须包含的环境变量：**
   - `CREDENTIAL_PROXY_HOST=0.0.0.0`
   - `APPLE_CONTAINER_HOST=192.168.64.1`

2. **验证配置命令：**
   ```bash
   # 检查环境变量
   launchctl getenv CREDENTIAL_PROXY_HOST
   launchctl getenv APPLE_CONTAINER_HOST
   
   # 检查凭证代理监听地址
   lsof -i :3001
   
   # 验证 plist 格式
   plutil -lint ~/Library/LaunchAgents/com.nanoclaw.plist
   ```

3. **权限考虑：**
   - 首次运行可能需要授权网络访问
   - 检查防火墙设置是否阻止 3001 端口

### 8.2 Linux 配置要点

#### Docker 组权限

安装 Docker 后，用户需要加入 `docker` 组才能免 sudo 运行：

```bash
# 添加用户到 docker 组
sudo usermod -aG docker $USER

# 应用更改（重新登录或执行）
newgrp docker

# 验证
docker ps
```

**常见问题：** 如果服务启动后无法访问 Docker，可能是组权限未生效：

```bash
# 临时修复（立即生效）
sudo setfacl -m u:$(whoami):rw /var/run/docker.sock

# 永久修复
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```

#### WSL 特殊配置

**启用 systemd（推荐）：**

```bash
# 在 WSL 中启用 systemd
echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf

# 重启 WSL
wsl --shutdown
# 重新打开 WSL
```

**不使用 systemd：**

使用提供的 `start-nanoclaw.sh` 脚本（见 7.1 节）。

---

## 9. 常见问题排查指南

### 9.1 安装阶段问题

#### Node.js 版本不匹配

**症状：** `NODE_OK: false`

**解决：**
```bash
# 检查当前版本
node --version

# 使用 nvm 切换到正确版本
nvm install 22
nvm use 22

# 重新运行设置
bash setup.sh
```

#### 依赖安装失败

**症状：** `DEPS_OK: false`，错误日志显示编译错误

**解决：**
```bash
# 清理并重新安装
rm -rf node_modules package-lock.json
npm install

# macOS: 安装 Xcode 命令行工具
xcode-select --install

# Linux: 安装构建工具
sudo apt-get update
sudo apt-get install -y build-essential python3
```

#### 原生模块加载失败

**症状：** `NATIVE_OK: false`，better-sqlite3 错误

**解决：**
```bash
# 重新编译原生模块
npm rebuild

# 或完全清理重装
rm -rf node_modules
npm install
```

### 9.2 容器运行时问题

#### Docker 未启动

**症状：** `DOCKER: installed_not_running`

**解决：**
```bash
# macOS
open -a Docker

# Linux
sudo systemctl start docker

# 等待后验证
docker info
```

#### Apple Container 网络连接失败

**症状：** 容器无法连接 API，`ENOTFOUND` 或 `ECONNREFUSED`

**排查步骤：**

1. **检查凭证代理监听地址：**
   ```bash
   lsof -i :3001
   # 应显示监听 *:3001 或 0.0.0.0:3001
   # 如果只显示 127.0.0.1:3001，说明 CREDENTIAL_PROXY_HOST 未生效
   ```

2. **检查环境变量：**
   ```bash
   launchctl getenv CREDENTIAL_PROXY_HOST
   # 应显示 0.0.0.0
   
   launchctl getenv APPLE_CONTAINER_HOST
   # 应显示 192.168.64.1
   ```

3. **测试网络连通性：**
   ```bash
   echo '{}' | container run -i --rm --entrypoint /bin/bash nanoclaw-agent:latest \
     -c "curl -s http://192.168.64.1:3001/v1/models -H 'Authorization: Bearer test'"
   ```

4. **重启服务以应用环境变量：**
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
   ```

#### 镜像构建失败

**症状：** `BUILD_OK: false`

**解决：**
```bash
# 清理构建缓存（Docker）
docker builder prune -f

# 清理构建缓存（Apple Container）
container builder stop
container builder rm
container builder start

# 重新构建
bash container/build.sh
```

### 9.3 认证问题

#### 凭证代理连接失败

**症状：** 日志显示 "Unable to connect to API"

**排查：**
1. 检查 `.env` 文件是否存在且包含有效凭证
2. 检查 `data/env/env` 是否已同步
3. 检查凭证代理是否运行：`lsof -i :3001`

#### API 返回 404

**症状：** 响应中包含 nginx 404 页面或 `{"error":"Not Found"}`

**原因：** 使用了自定义 API 端点（如 `https://api.kimi.com/coding/`），路径拼接错误

**解决：** 确保 `src/credential-proxy.ts` 正确拼接路径：
```typescript
const upstreamPath = upstreamUrl.pathname.replace(/\/$/, '') + req.url;
```

### 9.4 通道连接问题

#### WeCom Bot 无法连接

**症状：** 没有收到消息，日志无 WeCom 相关记录

**排查：**
1. 检查 `.env` 中 `WECOM_BOT_ID` 和 `WECOM_BOT_SECRET` 是否正确
2. 检查 `data/env/env` 是否已同步
3. 检查服务是否已重启以加载新环境变量
4. 检查 WeCom Bot 是否有 WebSocket 连接权限

#### 消息无响应

**症状：** 收到消息但无 AI 响应

**排查：**
1. **检查 JID 是否已注册：**
   ```bash
   sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'wc:%';"
   ```

2. **检查触发词设置：**
   - 私聊（`isMain: true`）: 不需要触发词
   - 群聊（`requiresTrigger: true`）: 需要使用 `@助手名` 触发

3. **检查容器是否正常运行：**
   ```bash
   # macOS
   tail -f groups/main/logs/container-*.log
   
   # 检查容器状态
   docker ps  # 或 container ps
   ```

#### JID 格式错误

**症状：** 消息被记录为 "Unregistered chat" 但已注册

**排查：** 确保 JID 格式完全匹配：
- 私聊：`wc:user:USERID`（注意是 `user` 不是 `users`）
- 群聊：`wc:group:GROUPID`

### 9.5 服务启动问题

#### launchd 服务失败

**症状：** `launchctl list | grep nanoclaw` 显示状态非 0

**排查：**
```bash
# 查看详细状态
launchctl list com.nanoclaw

# 查看错误日志
cat logs/nanoclaw.error.log

# 检查 plist 格式
plutil -lint ~/Library/LaunchAgents/com.nanoclaw.plist
```

**常见问题：**
- Node 路径错误：使用 `which node` 获取正确路径
- 工作目录错误：使用绝对路径
- 权限问题：检查日志目录可写

#### systemd 服务失败

**症状：** `systemctl --user status nanoclaw` 显示失败

**排查：**
```bash
# 查看详细状态
systemctl --user status nanoclaw

# 查看日志
journalctl --user -u nanoclaw -n 50

# 检查文件路径
ls -la ~/.config/systemd/user/nanoclaw.service
```

### 9.6 快速排查检查清单

| 问题现象 | 首要检查 | 次要检查 |
|----------|----------|----------|
| 安装失败 | Node 版本 | 编译工具 |
| 容器无法启动 | Docker/Container 运行状态 | 镜像是否存在 |
| API 连接失败 | 凭证代理运行状态 | 环境变量配置 |
| 消息无响应 | 群组是否注册 | JID 格式 |
| 服务无法启动 | 日志文件 | plist/systemd 配置 |

---

## 10. Docker Sandbox 部署（可选高级）

Docker Sandbox 提供了额外的隔离层，适合对安全性要求更高的场景。

### 10.1 何时需要 Docker Sandbox？

- 需要 hypervisor 级别的隔离
- 运行不受信任的代码
- 多租户环境

### 10.2 架构说明

```
Host (macOS / Windows WSL)
└── Docker Sandbox (micro VM with isolated kernel)
    ├── NanoClaw process (Node.js)
    │   ├── Channel adapters (WhatsApp, Telegram, etc.)
    │   └── Container spawner → nested Docker daemon
    └── Docker-in-Docker
        └── nanoclaw-agent containers
            └── Claude Agent SDK
```

### 10.3 部署要求

- Docker Desktop v4.40+
- Anthropic API Key
- 沙盒代理自动处理 API 认证

### 10.4 快速开始

```bash
# 创建工作空间
mkdir -p ~/nanoclaw-workspace

# 创建沙盒
docker sandbox create shell ~/nanoclaw-workspace

# 配置代理绕过（如果使用 WhatsApp）
docker sandbox network proxy shell-nanoclaw-workspace \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"

# 进入沙盒
docker sandbox run shell-nanoclaw-workspace

# 在沙盒内按照第 3-9 节的步骤部署
```

### 10.5 特殊配置

Docker Sandbox 需要额外的代理配置补丁，详见 `docs/docker-sandboxes.md`。

---

## 附录

### A. 完整环境变量参考

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `ANTHROPIC_API_KEY` | 二选一 | Anthropic API Key |
| `CLAUDE_CODE_OAUTH_TOKEN` | 二选一 | Claude Code OAuth Token |
| `ASSISTANT_NAME` | 是 | 助手名称（默认 nanoclaw） |
| `WECOM_BOT_ID` | 否 | 企业微信 Bot ID |
| `WECOM_BOT_SECRET` | 否 | 企业微信 Bot Secret |
| `CREDENTIAL_PROXY_HOST` | 条件 | 凭证代理绑定地址（Apple Container 需设为 0.0.0.0） |
| `APPLE_CONTAINER_HOST` | 条件 | Apple Container 主机 IP（默认 192.168.64.1） |
| `ANTHROPIC_BASE_URL` | 否 | 自定义 API 端点 |
| `ANTHROPIC_AUTH_TOKEN` | 否 | 自定义 API 认证令牌 |

### B. 常用命令速查

```bash
# 构建
npm run build

# 测试
npm test

# 启动（开发模式）
npm start

# 服务管理（macOS）
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 服务管理（Linux）
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw

# 查看日志
tail -f logs/nanoclaw.log
tail -f logs/nanoclaw.error.log

# 数据库查询
sqlite3 store/messages.db "SELECT * FROM registered_groups;"
```

### C. 更新 NanoClaw

```bash
# 拉取上游更新
git fetch upstream
git merge upstream/main

# 重新安装依赖
npm install

# 重新构建
npm run build

# 重启服务
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

---

**恭喜！** 您已完成 NanoClaw 的完整部署。现在您可以通过配置的消息通道与您的 AI 助手对话了。

如有问题，请查看日志文件或运行 `claude` 后询问 Claude Code 获取帮助。
