import {
    DaemonVoiceRuntimeStartRequestSchema,
    DaemonVoiceRuntimeStartResponseSchema,
    DaemonVoiceRuntimeStopRequestSchema,
    DaemonVoiceRuntimeStopResponseSchema,
    type DaemonVoiceRuntimeStartRequest,
    type DaemonVoiceRuntimeStartResponse,
    type DaemonVoiceRuntimeStopResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineVoiceRuntimeOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

/** Starts the machine's realtime voice runtime and returns its WebRTC answer. */
export async function machineVoiceRuntimeStart(
    machineId: string,
    input: DaemonVoiceRuntimeStartRequest,
    opts?: MachineVoiceRuntimeOpts,
): Promise<DaemonVoiceRuntimeStartResponse> {
    const payload = DaemonVoiceRuntimeStartRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonVoiceRuntimeStartRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_VOICE_RUNTIME_START,
        payload,
    });
    const parsed = DaemonVoiceRuntimeStartResponseSchema.safeParse(response);
    if (!parsed.success) throwUnsupportedResponse(RPC_METHODS.DAEMON_VOICE_RUNTIME_START);
    return parsed.data;
}

export async function machineVoiceRuntimeStop(
    machineId: string,
    sessionKey: string,
    opts?: MachineVoiceRuntimeOpts,
): Promise<DaemonVoiceRuntimeStopResponse> {
    const payload = DaemonVoiceRuntimeStopRequestSchema.parse({ sessionKey });
    const response = await machineRpcWithServerScope<unknown, typeof payload>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_VOICE_RUNTIME_STOP,
        payload,
    });
    const parsed = DaemonVoiceRuntimeStopResponseSchema.safeParse(response);
    if (!parsed.success) throwUnsupportedResponse(RPC_METHODS.DAEMON_VOICE_RUNTIME_STOP);
    return parsed.data;
}
