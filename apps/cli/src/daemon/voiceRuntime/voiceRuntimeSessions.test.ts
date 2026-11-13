import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DaemonVoiceRuntimeStartRequest } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVoiceRuntimeSessionManager } from './voiceRuntimeSessions';

// A stand-in runtime speaking the real stdio protocol (apps/voice-runtime `__main__.py`). The
// answer's sdp reports what the start line carried, so the test can see the wire mapping.
const FAKE_RUNTIME = `
const mode = process.argv[2];
if (mode === 'exit') process.exit(3);
let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const newline = buffered.indexOf('\\n');
  if (newline < 0) return;
  const start = JSON.parse(buffered.slice(0, newline));
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ type: 'error', code: 'invalid_config', fields: ['credential.value'] }) + '\\n');
    process.exit(2);
  }
  const summary = {
    type: start.type,
    credential: start.config.credential.value,
    configKeys: Object.keys(start.config).sort(),
    offerType: start.offer.type,
  };
  process.stdout.write(JSON.stringify({ type: 'answer', sdp: JSON.stringify(summary), sdpType: 'answer', pcId: 'pc' }) + '\\n');
});
process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ type: 'ended', reason: 'stopped' }) + '\\n');
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

function request(sessionKey: string): DaemonVoiceRuntimeStartRequest {
  return {
    sessionKey,
    config: {
      credential: { kind: 'api_key', value: 'dg-test-key' },
      stt: { model: 'flux-general-en' },
      tts: { voice: 'aura-2-helena-en' },
      iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
    },
    offer: { type: 'offer', sdp: 'v=0' },
  };
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('voice runtime sessions', () => {
  let dir: string;
  let script: string;
  const pids: number[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-runtime-test-'));
    script = join(dir, 'fake-runtime.cjs');
    await writeFile(script, FAKE_RUNTIME);
  });

  afterEach(async () => {
    for (const pid of pids.splice(0)) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  });

  const managerFor = (mode: string) => {
    return createVoiceRuntimeSessionManager({
      resolveLaunch: () => ({ file: process.execPath, args: [script, mode] }),
      spawn: (launch) => {
        const child = spawn(launch.file, [...launch.args], { stdio: ['pipe', 'pipe', 'pipe'] });
        if (child.pid) pids.push(child.pid);
        return child;
      },
    });
  };

  it('starts a runtime with the credential on its stdin and returns the answer', async () => {
    const response = await managerFor('answer').start(request('call-1'));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(JSON.parse(response.answer.sdp)).toEqual({
      type: 'start',
      credential: 'dg-test-key',
      configKeys: ['credential', 'ice_servers', 'stt', 'tts'],
      offerType: 'offer',
    });
  });

  it('reports the runtime refusing to start, and does not leave it running', async () => {
    const response = await managerFor('error').start(request('call-2'));
    expect(response).toMatchObject({ ok: false, errorCode: 'voice_runtime_start_failed', runtimeCode: 'invalid_config' });
    expect(pids.some(isAlive)).toBe(false);
  });

  it('reports a runtime that exits before answering', async () => {
    const response = await managerFor('exit').start(request('call-3'));
    expect(response).toMatchObject({ ok: false, errorCode: 'voice_runtime_start_failed', runtimeCode: 'exited' });
  });

  it('is unavailable on a machine without a runtime', async () => {
    const manager = createVoiceRuntimeSessionManager({ resolveLaunch: () => null });
    expect(await manager.start(request('call-4'))).toMatchObject({ ok: false, errorCode: 'voice_runtime_unavailable' });
  });

  it('stops a running session by terminating its process, once', async () => {
    const manager = managerFor('answer');
    await manager.start(request('call-5'));
    expect(pids.some(isAlive)).toBe(true);
    expect(await manager.stop('call-5')).toEqual({ ok: true });
    expect(pids.some(isAlive)).toBe(false);
    expect(await manager.stop('call-5')).toMatchObject({ ok: false, errorCode: 'voice_runtime_not_found' });
  });

  it('refuses a second start for a live session key and leaves the running runtime alone', async () => {
    const manager = managerFor('answer');
    await manager.start(request('call-6'));
    const [first] = pids;
    expect(await manager.start(request('call-6'))).toMatchObject({ ok: false, errorCode: 'voice_runtime_invalid_request' });
    expect(pids).toHaveLength(1);
    expect(isAlive(first)).toBe(true);
    await manager.stop('call-6');
  });

  it('reports a stop it could not verify and keeps the runtime reachable for another stop', async () => {
    let failNext = true;
    const { spawn: spawnChild } = await import('node:child_process');
    const manager = createVoiceRuntimeSessionManager({
      resolveLaunch: () => ({ file: process.execPath, args: [script, 'answer'] }),
      spawn: (launch) => {
        const child = spawnChild(launch.file, [...launch.args], { stdio: ['pipe', 'pipe', 'pipe'] });
        if (child.pid) pids.push(child.pid);
        return child;
      },
      terminate: async (child) => {
        if (failNext) {
          failNext = false;
          throw new Error('process_tree_termination_incomplete');
        }
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      },
    });
    await manager.start(request('call-7'));
    expect(await manager.stop('call-7')).toMatchObject({ ok: false, errorCode: 'voice_runtime_stop_failed' });
    expect(await manager.stop('call-7')).toEqual({ ok: true });
    expect(pids.some(isAlive)).toBe(false);
  });

  it('does not start a runtime whose stop arrived first', async () => {
    // A stop can overtake its start on a different route; the late start must not spawn a runtime
    // that nothing would stop.
    const manager = managerFor('answer');
    expect(await manager.stop('call-8')).toMatchObject({ ok: false, errorCode: 'voice_runtime_not_found' });
    expect(await manager.start(request('call-8'))).toMatchObject({
      ok: false,
      errorCode: 'voice_runtime_start_failed',
      runtimeCode: 'stopped',
    });
    expect(pids).toHaveLength(0);
  });

  // A stop for a runtime that already ended is that call's normal hang-up, not a stop that overtook
  // its start: it leaves nothing behind (observable here as the key staying startable).
  it('leaves no stop mark for a runtime that refused to start', async () => {
    const manager = managerFor('error');
    await manager.start(request('call-9'));
    expect(await manager.stop('call-9')).toMatchObject({ ok: false, errorCode: 'voice_runtime_not_found' });
    expect(await manager.start(request('call-9'))).toMatchObject({ ok: false, runtimeCode: 'invalid_config' });
  });

  it('leaves no stop mark for a runtime that ended by itself', async () => {
    const manager = managerFor('answer');
    expect(await manager.start(request('call-10'))).toMatchObject({ ok: true });
    const pid = pids[pids.length - 1]!;
    process.kill(pid, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const check = () => (isAlive(pid) ? setTimeout(check, 10) : resolve());
      check();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await manager.stop('call-10')).toMatchObject({ ok: false, errorCode: 'voice_runtime_not_found' });
    expect(await manager.start(request('call-10'))).toMatchObject({ ok: true });
    await manager.stop('call-10');
  });
});
