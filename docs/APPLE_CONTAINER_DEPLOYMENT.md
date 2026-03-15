# Apple Container 部署经验总结

## 概述

本文档总结了将 NanoClaw 部署到 Apple Container 运行时遇到的问题和解决方案。

## 关键差异：Apple Container vs Docker Desktop

| 特性 | Docker Desktop | Apple Container |
|------|---------------|-----------------|
| host.docker.internal | ✅ 内置支持 | ❌ 不支持 |
| 文件挂载 | 支持文件和目录 | 仅支持目录 |
| 网络模式 | VM 桥接 | 虚拟机网络隔离 |
| 容器访问主机 | 通过 host.docker.internal | 需通过主机 IP |

## 遇到的问题和解决方案

### 1. 容器无法访问主机的凭证代理

**问题现象：**
```
API Error: Unable to connect to API (ENOTFOUND)
```

**根本原因：**
Apple Container 没有 `host.docker.internal`，容器内无法解析主机地址。凭证代理默认绑定到 `127.0.0.1:3001`，但容器无法访问主机的回环地址。

**解决方案：**

1. **凭证代理绑定到所有接口**（`src/credential-proxy.ts` 已修复）：
   ```typescript
   // 由环境变量控制，无需修改代码
   // 默认值通过 detectProxyBindHost() 自动检测 Apple Container
   ```

2. **launchd 服务配置环境变量**（`~/Library/LaunchAgents/com.nanoclaw.plist`）：
   ```xml
   <key>EnvironmentVariables</key>
   <dict>
       <key>CREDENTIAL_PROXY_HOST</key>
       <string>0.0.0.0</string>
       <key>APPLE_CONTAINER_HOST</key>
       <string>192.168.64.1</string>
   </dict>
   ```

3. **容器通过主机 IP 访问**（`src/container-runtime.ts`）：
   ```typescript
   export const CONTAINER_HOST_GATEWAY = process.env.APPLE_CONTAINER_HOST || 'host.docker.internal';
   ```

**注意：** `192.168.64.1` 是 Apple Container VM 的网关 IP，容器可以通过此地址访问主机。

### 2. 凭证代理路径前缀处理错误

**问题现象：**
```
<html><head><title>404 Not Found</title></head>...</html>
```

**根本原因：**
当 `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/` 包含路径前缀时，凭证代理将 `/v1/models` 转发到 `/v1/models` 而不是 `/coding/v1/models`。

**解决方案：**
在 `src/credential-proxy.ts` 中正确拼接路径：
```typescript
// Prepend upstream URL pathname to request path
const upstreamPath = upstreamUrl.pathname.replace(/\/$/, '') + req.url;
```

### 3. plist 文件格式损坏

**问题现象：**
服务无法启动，launchctl 报错。

**根本原因：**
使用 `sed` 修改 plist XML 文件导致结构损坏（重复的 `<key>EnvironmentVariables</key>`）。

**解决方案：**
不要尝试用 sed 修改 plist，直接重写整个文件：
```bash
# 错误做法
sed -i '' 's...</dict>...' com.nanoclaw.plist

# 正确做法
cat > ~/Library/LaunchAgents/com.nanoclaw.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist ...>
...完整内容...
EOF
```

### 4. DNS/IPv6 问题的错误定位

**最初的错误尝试：**
在 Dockerfile 中添加：
```dockerfile
ENV NODE_OPTIONS=--dns-result-order=ipv4first
RUN echo '104.18.20.246 api.kimi.com' >> /etc/hosts
```

**问题：**
这些修复实际上是不必要的，因为：
1. 容器内的 Claude SDK 不再直接访问 `api.kimi.com`
2. 所有 API 请求都通过主机的凭证代理（`192.168.64.1:3001`）
3. DNS 解析在主机上完成，主机网络正常

**正确理解：**
```
容器内 SDK → http://192.168.64.1:3001 (IP地址，无需DNS) → 主机凭证代理 → https://api.kimi.com/coding/
                                                          ↑
                                                    主机DNS正常工作
```

## 部署检查清单

### 首次部署 Apple Container

1. **安装 Apple Container**
   ```bash
   container --version
   ```

2. **转换代码**（如果还没转换）
   ```bash
   /convert-to-apple-container
   ```

3. **配置 launchd 环境变量**
   ```xml
   <!-- 在 ~/Library/LaunchAgents/com.nanoclaw.plist 中添加 -->
   <key>EnvironmentVariables</key>
   <dict>
       <key>PATH</key>
       <string>/usr/local/bin:/usr/bin:/bin:/Users/$USER/.local/bin</string>
       <key>HOME</key>
       <string>/Users/$USER</string>
       <key>CREDENTIAL_PROXY_HOST</key>
       <string>0.0.0.0</string>
       <key>APPLE_CONTAINER_HOST</key>
       <string>192.168.64.1</string>
   </dict>
   ```

4. **构建镜像**
   ```bash
   ./container/build.sh
   ```

5. **测试网络连通性**
   ```bash
   # 测试容器能否访问凭证代理
   echo '{}' | container run -i --rm --entrypoint /bin/bash nanoclaw-agent:latest \
     -c "curl -s http://192.168.64.1:3001/v1/models -H 'Authorization: Bearer test'"
   ```

6. **启动服务**
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
   ```

### 故障排查

**容器无法连接凭证代理：**
```bash
# 检查凭证代理是否监听 0.0.0.0:3001
lsof -i :3001

# 检查环境变量是否正确设置
launchctl getenv CREDENTIAL_PROXY_HOST
launchctl getenv APPLE_CONTAINER_HOST
```

**API 返回 404：**
```bash
# 检查 credential-proxy.ts 是否正确拼接路径
grep "upstreamPath" src/credential-proxy.ts
```

**服务无法启动：**
```bash
# 检查 plist 格式
plutil -lint ~/Library/LaunchAgents/com.nanoclaw.plist

# 查看错误日志
cat logs/nanoclaw.error.log
```

## 架构设计要点

### 网络流程

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   容器内 Agent   │────▶│  192.168.64.1    │────▶│  主机凭证代理    │
│                 │     │  :3001           │     │  0.0.0.0:3001   │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                              ┌───────────────────────────┘
                              ▼
                    ┌──────────────────┐
                    │  api.kimi.com    │
                    │  /coding/v1/...  │
                    └──────────────────┘
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/credential-proxy.ts` | 必须正确处理 upstream URL 路径前缀 |
| `src/container-runtime.ts` | 自动检测 Apple Container 并配置网络 |
| `~/Library/LaunchAgents/com.nanoclaw.plist` | 必须包含 `CREDENTIAL_PROXY_HOST` 和 `APPLE_CONTAINER_HOST` |
| `container/Dockerfile` | 不需要 DNS/IPv6 修复（已在主机层解决） |

## 教训总结

1. **不要假设容器运行时的行为一致** - Apple Container ≠ Docker Desktop
2. **网络问题要分层分析** - 区分容器→主机、主机→外网两个环节
3. **避免在容器内修复主机层问题** - DNS 问题应在主机解决，而非容器内
4. **使用结构化方式修改配置文件** - sed 修改 XML/JSON 容易出错，建议重写或使用专用工具
5. **测试每个网络环节** - 分别测试容器→主机、主机→API，定位问题层次
