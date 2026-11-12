import { isAbsolute } from 'node:path';

export type VoiceRuntimeLaunch = Readonly<{ file: string; args: readonly string[] }>;

/**
 * Names the Python interpreter of an environment that has `happier-voice-runtime` installed
 * (apps/voice-runtime, `uv sync`), for example `<checkout>/apps/voice-runtime/.venv/bin/python`.
 */
export const VOICE_RUNTIME_PYTHON_ENV = 'HAPPIER_VOICE_RUNTIME_PYTHON';

/**
 * Where this machine's realtime voice runtime is, or null when it has none.
 *
 * Current ceiling: the runtime is not yet published as a first-party runtime component, so only an
 * explicitly configured interpreter is used and every other machine reports the runtime as
 * unavailable. Shipping it means adding it to the first-party component catalog as a
 * self-contained bundle (no system Python) and resolving that install here.
 */
export function resolveVoiceRuntimeLaunch(env: NodeJS.ProcessEnv = process.env): VoiceRuntimeLaunch | null {
  const python = env[VOICE_RUNTIME_PYTHON_ENV]?.trim();
  if (!python || !isAbsolute(python)) return null;
  return { file: python, args: ['-m', 'happier_voice_runtime'] };
}
