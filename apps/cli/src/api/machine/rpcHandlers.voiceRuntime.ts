import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  DaemonVoiceRuntimeStartRequestSchema,
  DaemonVoiceRuntimeStopRequestSchema,
  type DaemonVoiceRuntimeError,
} from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { resolveVoiceRuntimeLaunch } from '@/daemon/voiceRuntime/resolveVoiceRuntimeLaunch';
import {
  createVoiceRuntimeSessionManager,
  type VoiceRuntimeSessionManager,
} from '@/daemon/voiceRuntime/voiceRuntimeSessions';

const invalidRequest: DaemonVoiceRuntimeError = {
  ok: false,
  errorCode: 'voice_runtime_invalid_request',
  error: 'voice_runtime_invalid_request',
};

export function registerMachineVoiceRuntimeRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  sessionManager?: VoiceRuntimeSessionManager;
}>): void {
  const sessions = params.sessionManager ?? createVoiceRuntimeSessionManager({ resolveLaunch: () => resolveVoiceRuntimeLaunch() });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_RUNTIME_START, async (raw: unknown) => {
    const parsed = DaemonVoiceRuntimeStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest;
    return sessions.start(parsed.data);
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_RUNTIME_STOP, async (raw: unknown) => {
    const parsed = DaemonVoiceRuntimeStopRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest;
    return sessions.stop(parsed.data.sessionKey);
  });
}
