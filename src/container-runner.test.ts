import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner streaming output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onOutput for each streamed result in order', async () => {
    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (o: ContainerOutput) => {
      outputs.push(o);
    });
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit multiple outputs (simulating agent teams producing multiple results)
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First chunk',
      newSessionId: 'session-stream',
    });

    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second chunk',
      newSessionId: 'session-stream',
    });

    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Final chunk',
      newSessionId: 'session-stream',
    });

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledTimes(3);
    expect(outputs.map((o) => o.result)).toEqual([
      'First chunk',
      'Second chunk',
      'Final chunk',
    ]);
  });

  it('handles partial marker delivery across multiple data events', async () => {
    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (o: ContainerOutput) => {
      outputs.push(o);
    });
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Simulate the marker arriving split across two data events
    const json = JSON.stringify({
      status: 'success',
      result: 'Split delivery',
      newSessionId: 'session-split',
    });
    const fullPayload = `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`;

    // Split roughly in the middle of the JSON
    const splitPoint = Math.floor(fullPayload.length / 2);
    fakeProc.stdout.push(fullPayload.slice(0, splitPoint));

    await vi.advanceTimersByTimeAsync(10);
    // onOutput should NOT have been called yet — marker pair is incomplete
    expect(onOutput).not.toHaveBeenCalled();

    // Push the rest
    fakeProc.stdout.push(fullPayload.slice(splitPoint));
    await vi.advanceTimersByTimeAsync(10);

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(outputs[0].result).toBe('Split delivery');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
  });

  it('resets hard timeout on each streaming output', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Advance to just before the hard timeout
    await vi.advanceTimersByTimeAsync(1829000);

    // Emit output — this should reset the hard timeout
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Late output',
      newSessionId: 'session-reset',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Advance again to what would have been past the original timeout
    // but should be within the reset window
    await vi.advanceTimersByTimeAsync(1000);

    // Container should NOT have been killed — emit normal close
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('tracks newSessionId across multiple outputs', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // First output sets the session
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First',
      newSessionId: 'session-v1',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Second output updates the session
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second',
      newSessionId: 'session-v2',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Should have the latest session ID
    expect(result.newSessionId).toBe('session-v2');
  });

  it('handles null result outputs (session-update markers)', async () => {
    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (o: ContainerOutput) => {
      outputs.push(o);
    });
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit a real result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Actual response',
      newSessionId: 'session-null',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Emit a session-update marker (null result)
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-null',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    // Both outputs should be delivered (null results still trigger onOutput
    // so that idle timers and session tracking work correctly)
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(outputs[0].result).toBe('Actual response');
    expect(outputs[1].result).toBeNull();
  });
});
