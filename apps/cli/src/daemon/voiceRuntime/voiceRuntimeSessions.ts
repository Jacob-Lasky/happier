import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  DaemonVoiceRuntimeError,
  DaemonVoiceRuntimeErrorCode,
  DaemonVoiceRuntimeStartRequest,
  DaemonVoiceRuntimeStartResponse,
  DaemonVoiceRuntimeStopResponse,
} from '@happier-dev/protocol';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { logger } from '@/ui/logger';

import type { VoiceRuntimeLaunch } from './resolveVoiceRuntimeLaunch';

type SpawnRuntime = (launch: VoiceRuntimeLaunch) => ChildProcessWithoutNullStreams;

export type VoiceRuntimeSessionManager = Readonly<{
  start: (request: DaemonVoiceRuntimeStartRequest) => Promise<DaemonVoiceRuntimeStartResponse>;
  stop: (sessionKey: string) => Promise<DaemonVoiceRuntimeStopResponse>;
}>;

function failure(errorCode: DaemonVoiceRuntimeErrorCode, runtimeCode?: string): DaemonVoiceRuntimeError {
  return { ok: false, errorCode, error: errorCode, ...(runtimeCode ? { runtimeCode } : {}) };
}

function defaultSpawn(launch: VoiceRuntimeLaunch): ChildProcessWithoutNullStreams {
  return spawnChildProcess(launch.file, [...launch.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Owns the daemon's realtime voice runtime processes: one per app-chosen session key.
 *
 * The runtime speaks a line-delimited JSON protocol (apps/voice-runtime, `__main__.py`): the start
 * line carries the configuration and the WebRTC offer, the first reply is the answer or an error.
 * The credential travels only on that stdin line. Stopping goes through the canonical process-tree
 * termination, which the runtime treats as a clean stop; a runtime whose daemon dies sees its
 * stdin close and ends itself.
 */
export function createVoiceRuntimeSessionManager(deps: Readonly<{
  resolveLaunch: () => VoiceRuntimeLaunch | null;
  spawn?: SpawnRuntime;
  /** Ends a runtime's process tree; rejects when that could not be verified. */
  terminate?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
}>): VoiceRuntimeSessionManager {
  const spawn = deps.spawn ?? defaultSpawn;
  const terminateTree = deps.terminate ?? (async (child: ChildProcessWithoutNullStreams) => {
    await killProcessTree(child);
  });
  const sessions = new Map<string, ChildProcessWithoutNullStreams>();
  /**
   * The app sends exactly one stop for every start it issued, and a start and its stop can take
   * different routes, so the stop can arrive first. These two sets tell a stop that overtook its
   * start (the late start must then not spawn a runtime nothing would stop) from the normal hang-up
   * of a runtime that already ended. Each entry is consumed by the call's other half; only a call
   * whose other half never arrives (a start lost in transit, an app gone before hanging up) leaves
   * its key behind, a short string for the daemon's lifetime.
   */
  const endedAwaitingStop = new Set<string>();
  const stoppedBeforeStart = new Set<string>();

  const forget = (sessionKey: string, child: ChildProcessWithoutNullStreams) => {
    if (sessions.get(sessionKey) !== child) return;
    sessions.delete(sessionKey);
    endedAwaitingStop.add(sessionKey);
  };

  /** True once the runtime is gone. False keeps it tracked, so a later stop can try again. */
  const terminate = async (child: ChildProcessWithoutNullStreams): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    try {
      await terminateTree(child);
      return true;
    } catch {
      // The process-tree owner records why cleanup could not be verified.
      return false;
    }
  };

  const stop = async (sessionKey: string): Promise<DaemonVoiceRuntimeStopResponse> => {
    const child = sessions.get(sessionKey);
    if (!child) {
      if (!endedAwaitingStop.delete(sessionKey)) stoppedBeforeStart.add(sessionKey);
      return failure('voice_runtime_not_found');
    }
    if (!(await terminate(child))) return failure('voice_runtime_stop_failed');
    if (sessions.get(sessionKey) === child) sessions.delete(sessionKey);
    // Its exit may already have recorded it as ended; this stop is that call's other half.
    endedAwaitingStop.delete(sessionKey);
    return { ok: true };
  };

  const start = async (request: DaemonVoiceRuntimeStartRequest): Promise<DaemonVoiceRuntimeStartResponse> => {
    const launch = deps.resolveLaunch();
    if (!launch) return failure('voice_runtime_unavailable');

    // The app picks a fresh key for every call, so a live key means a duplicate request. Refusing
    // it (rather than replacing the runtime) leaves exactly one owner per key with no await between
    // this check and claiming the key below.
    if (sessions.has(request.sessionKey)) return failure('voice_runtime_invalid_request');
    if (stoppedBeforeStart.delete(request.sessionKey)) return failure('voice_runtime_start_failed', 'stopped');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch);
    } catch (error) {
      logger.debug('[voice-runtime] spawn failed', { message: error instanceof Error ? error.message : String(error) });
      return failure('voice_runtime_start_failed', 'spawn_failed');
    }
    sessions.set(request.sessionKey, child);

    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => logger.debug(`[voice-runtime] ${line}`));

    const firstReply = new Promise<DaemonVoiceRuntimeStartResponse>((resolve) => {
      const stdout = createInterface({ input: child.stdout });
      stdout.on('line', (line) => {
        let message: { type?: unknown; sdp?: unknown; code?: unknown; reason?: unknown } | null = null;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message?.type === 'answer' && typeof message.sdp === 'string' && message.sdp.length > 0) {
          resolve({ ok: true, answer: { type: 'answer', sdp: message.sdp } });
        } else if (message?.type === 'error') {
          resolve(failure('voice_runtime_start_failed', typeof message.code === 'string' ? message.code : undefined));
        } else if (message?.type === 'ended') {
          logger.debug('[voice-runtime] session ended', { reason: message.reason });
        }
      });
      child.once('error', () => resolve(failure('voice_runtime_start_failed', 'spawn_failed')));
      child.once('exit', () => resolve(failure('voice_runtime_start_failed', 'exited')));
    });

    child.once('exit', () => forget(request.sessionKey, child));

    // The runtime's config is snake_case (Python); the wire request is the protocol's camelCase.
    const { credential, stt, tts, iceServers } = request.config;
    const startLine = JSON.stringify({
      type: 'start',
      config: { credential, stt, tts, ice_servers: iceServers },
      offer: request.offer,
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${startLine}\n`);

    const reply = await firstReply;
    if (!reply.ok && sessions.get(request.sessionKey) === child && (await terminate(child))) {
      forget(request.sessionKey, child);
    }
    return reply;
  };

  return { start, stop };
}
