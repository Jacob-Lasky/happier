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

type MachineVoiceRuntimeStartOpts = MachineVoiceRuntimeOpts & Readonly<{
    /**
     * Called just before the start request is emitted. The transport fences an attempt it gave up
     * on before emission, so a start never sent is never sent later; one that was sent may have
     * started a runtime and needs a stop.
     */
    onIssued?: () => void;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

/** Starts the machine's realtime voice runtime and returns its WebRTC answer. */
export async function machineVoiceRuntimeStart(
    machineId: string,
    input: DaemonVoiceRuntimeStartRequest,
    opts?: MachineVoiceRuntimeStartOpts,
): Promise<DaemonVoiceRuntimeStartResponse> {
    const payload = DaemonVoiceRuntimeStartRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonVoiceRuntimeStartRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_VOICE_RUNTIME_START,
        payload,
        ...(opts?.onIssued ? { onIssued: opts.onIssued } : {}),
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
