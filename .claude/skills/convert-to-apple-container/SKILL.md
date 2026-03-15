---
name: convert-to-apple-container
description: Switch from Docker to Apple Container for macOS-native container isolation. Use when the user wants Apple Container instead of Docker, or is setting up on macOS and prefers the native runtime. Triggers on "apple container", "convert to apple container", "switch to apple container", or "use apple container".
---

# Convert to Apple Container

This skill switches NanoClaw's container runtime from Docker to Apple Container (macOS-only). It uses the skills engine for deterministic code changes, then walks through verification.

**What this changes:**
- Container runtime binary: `docker` → `container`
- Mount syntax: `-v path:path:ro` → `--mount type=bind,source=...,target=...,readonly`
- Startup check: `docker info` → `container system status` (with auto-start)
- Orphan detection: `docker ps --filter` → `container ls --format json`
- Build script default: `docker` → `container`
- Dockerfile entrypoint: `.env` shadowing via `mount --bind` inside the container (Apple Container only supports directory mounts, not file mounts like Docker's `/dev/null` overlay)
- Container runner: main-group containers start as root for `mount --bind`, then drop privileges via `setpriv`
- Credential proxy: properly handles upstream URL path prefixes (e.g., `/coding/` in `ANTHROPIC_BASE_URL`)

**What stays the same:**
- Mount security/allowlist validation
- All exported interfaces and IPC protocol
- Non-main container behavior (still uses `--user` flag)
- All other functionality

## Prerequisites

Verify Apple Container is installed:

```bash
container --version && echo "Apple Container ready" || echo "Install Apple Container first"
```

If not installed:
- Download from https://github.com/apple/container/releases
- Install the `.pkg` file
- Verify: `container --version`

Apple Container requires macOS. It does not work on Linux.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep "CONTAINER_RUNTIME_BIN" src/container-runtime.ts
```

If it already shows `'container'`, the runtime is already Apple Container. Skip to Phase 3.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/apple-container
git merge upstream/skill/apple-container
```

This merges in:
- `src/container-runtime.ts` — Apple Container implementation (replaces Docker)
- `src/container-runtime.test.ts` — Apple Container-specific tests
- `src/container-runner.ts` — .env shadow mount fix and privilege dropping
- `container/Dockerfile` — entrypoint that shadows .env via `mount --bind`
- `container/build.sh` — default runtime set to `container`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Verify

### Ensure Apple Container runtime is running

```bash
container system status || container system start
```

### Build the container image

```bash
./container/build.sh
```

### Test basic execution

```bash
echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK"
```

### Test readonly mounts

```bash
mkdir -p /tmp/test-ro && echo "test" > /tmp/test-ro/file.txt
container run --rm --entrypoint /bin/bash \
  --mount type=bind,source=/tmp/test-ro,target=/test,readonly \
  nanoclaw-agent:latest \
  -c "cat /test/file.txt && touch /test/new.txt 2>&1 || echo 'Write blocked (expected)'"
rm -rf /tmp/test-ro
```

Expected: Read succeeds, write fails with "Read-only file system".

### Test read-write mounts

```bash
mkdir -p /tmp/test-rw
container run --rm --entrypoint /bin/bash \
  -v /tmp/test-rw:/test \
  nanoclaw-agent:latest \
  -c "echo 'test write' > /test/new.txt && cat /test/new.txt"
cat /tmp/test-rw/new.txt && rm -rf /tmp/test-rw
```

Expected: Both operations succeed.

### Configure launchd environment variables (CRITICAL)

Apple Container requires special network configuration. The credential proxy must bind to all interfaces, and containers need to know the host IP.

Edit `~/Library/LaunchAgents/com.nanoclaw.plist` and add environment variables:

```xml
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

**Why this is needed:**
- Apple Container does NOT support `host.docker.internal`
- Containers cannot access host's `127.0.0.1`
- `192.168.64.1` is the VM gateway that containers can reach
- Without this, agents will fail with "Unable to connect to API (ENOTFOUND)"

### Full integration test

```bash
npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
sleep 5
```

Test container can reach credential proxy:
```bash
echo '{}' | container run -i --rm --entrypoint /bin/bash nanoclaw-agent:latest \
  -c "curl -s http://192.168.64.1:3001/v1/models -H 'Authorization: Bearer test' 2>&1 | head -1"
```

Expected: `{"data":[{"id":"kimi-for-coding"...` (models list)

Send a message via your configured channel and verify the agent responds.

## Troubleshooting

**Apple Container not found:**
- Download from https://github.com/apple/container/releases
- Install the `.pkg` file
- Verify: `container --version`

**Runtime won't start:**
```bash
container system start
container system status
```

**Image build fails:**
```bash
# Clean rebuild — Apple Container caches aggressively
container builder stop && container builder rm && container builder start
./container/build.sh
```

**Container can't write to mounted directories:**
Check directory permissions on the host. The container runs as uid 1000.

**API returns 404 Not Found (nginx error page):**
This indicates the credential proxy is not correctly forwarding URL paths when using a custom `ANTHROPIC_BASE_URL` with a path prefix (e.g., `https://api.kimi.com/coding/`).

Verify the fix is in place:
```bash
grep "upstreamPath" src/credential-proxy.ts
```

Should show: `const upstreamPath = upstreamUrl.pathname...`

If missing, the code is outdated. Pull the latest changes:
```bash
git fetch upstream
git merge upstream/main
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**"Unable to connect to API (ENOTFOUND)" in container logs:**
The container cannot reach the credential proxy. This is the most common Apple Container issue.

1. Verify launchd environment variables:
   ```bash
   launchctl getenv CREDENTIAL_PROXY_HOST  # Should print: 0.0.0.0
   launchctl getenv APPLE_CONTAINER_HOST   # Should print: 192.168.64.1
   ```

2. If empty or wrong, reload the plist:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
   sleep 3
   ```

3. Verify credential proxy is listening on all interfaces:
   ```bash
   lsof -i :3001 | grep LISTEN  # Should show *:3001 not 127.0.0.1:3001
   ```

4. Test container connectivity:
   ```bash
   echo '{}' | container run -i --rm --entrypoint /bin/bash nanoclaw-agent:latest \
     -c "curl -s http://192.168.64.1:3001/v1/models -H 'Authorization: Bearer test' 2>&1 | head -1"
   ```
   Expected: `{"data":[{...` (models list). If "Connection refused", check steps 1-3.

**Service fails to start after editing plist:**
If you manually edited `com.nanoclaw.plist`, validate the XML format:
```bash
plutil -lint ~/Library/LaunchAgents/com.nanoclaw.plist
```

Common mistake: Using sed to modify XML causes malformed structure. Always rewrite the entire file or use proper XML editing tools.

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `src/container-runtime.ts` | Full replacement — Docker → Apple Container API |
| `src/container-runtime.test.ts` | Full replacement — tests for Apple Container behavior |
| `src/container-runner.ts` | .env shadow mount removed, main containers start as root with privilege drop |
| `container/Dockerfile` | Entrypoint: `mount --bind` for .env shadowing, `setpriv` privilege drop |
| `container/build.sh` | Default runtime: `docker` → `container` |
