import { z } from 'zod';
import { lazySchema } from './lazySchema.js';

/**
 * Daemon-hosted realtime voice runtime (a Pipecat pipeline: Deepgram STT and TTS around an
 * app-owned conversation). The app negotiates WebRTC with it through these machine RPCs; the
 * audio itself flows peer to peer, not through the relay.
 */
export const DaemonVoiceRuntimeErrorCodeSchema = lazySchema(() => z.enum([
  'voice_runtime_unavailable',
  'voice_runtime_invalid_request',
  'voice_runtime_start_failed',
  'voice_runtime_not_found',
  /** Termination could not be verified; the runtime stays tracked so a later stop can retry. */
  'voice_runtime_stop_failed',
]));
export type DaemonVoiceRuntimeErrorCode = z.infer<typeof DaemonVoiceRuntimeErrorCodeSchema>;

export const DaemonVoiceRuntimeErrorSchema = lazySchema(() => z.object({
  ok: z.literal(false),
  errorCode: DaemonVoiceRuntimeErrorCodeSchema,
  error: z.string().min(1),
  /** The runtime's own reason when it refused to start (for example `invalid_config`). */
  runtimeCode: z.string().min(1).optional(),
}).passthrough());
export type DaemonVoiceRuntimeError = z.infer<typeof DaemonVoiceRuntimeErrorSchema>;

const RuntimeSessionKeySchema = z.string().trim().min(1).max(128);

const IceServerSchema = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(16),
  username: z.string().max(512).optional(),
  credential: z.string().max(2048).optional(),
});

export const DaemonVoiceRuntimeStartRequestSchema = lazySchema(() => z.object({
  /**
   * Chosen by the app before the call, so the app can stop a runtime whose start it gave up on
   * before an answer came back.
   */
  sessionKey: RuntimeSessionKeySchema,
  config: z.object({
    /**
     * The user's own Deepgram key, decrypted from their settings by the app. It reaches the
     * runtime over its stdin and is never persisted, logged, or put on a command line.
     */
    credential: z.object({ kind: z.literal('api_key'), value: z.string().min(1).max(4096) }),
    stt: z.object({ model: z.string().trim().min(1).max(128), language: z.string().trim().min(1).max(32).optional() }),
    tts: z.object({ voice: z.string().trim().min(1).max(128) }),
    iceServers: z.array(IceServerSchema).max(16),
  }),
  offer: z.object({ type: z.literal('offer'), sdp: z.string().min(1).max(200_000) }),
}));
export type DaemonVoiceRuntimeStartRequest = z.infer<typeof DaemonVoiceRuntimeStartRequestSchema>;

export const DaemonVoiceRuntimeStartResponseSchema = lazySchema(() => z.union([
  z.object({
    ok: z.literal(true),
    answer: z.object({ type: z.literal('answer'), sdp: z.string().min(1) }),
  }).passthrough(),
  DaemonVoiceRuntimeErrorSchema,
]));
export type DaemonVoiceRuntimeStartResponse = z.infer<typeof DaemonVoiceRuntimeStartResponseSchema>;

export const DaemonVoiceRuntimeStopRequestSchema = lazySchema(() => z.object({
  sessionKey: RuntimeSessionKeySchema,
}));
export type DaemonVoiceRuntimeStopRequest = z.infer<typeof DaemonVoiceRuntimeStopRequestSchema>;

export const DaemonVoiceRuntimeStopResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonVoiceRuntimeErrorSchema,
]));
export type DaemonVoiceRuntimeStopResponse = z.infer<typeof DaemonVoiceRuntimeStopResponseSchema>;
