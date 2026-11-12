# Realtime voice runtime (Pipecat)

Status: **development only**. The `realtime_pipecat` voice provider works from source checkouts
whose daemon is pointed at a runtime environment (see [Running it](#running-it)). The runtime is
not yet a first-party release component, so released CLIs report it as unavailable.

## What it is

`apps/voice-runtime` is a Python process built on [Pipecat](https://github.com/pipecat-ai/pipecat)
(pinned in its `pyproject.toml`). It owns the speech half of a realtime voice call:

```text
app mic ──WebRTC──▶ runtime: Deepgram STT ─▶ user turns ─▶ bridge ─▶ Deepgram TTS ──WebRTC──▶ app speaker
                                                            │  ▲
                                         happier.user_turn  ▼  │ happier.speak
                                                          the app
```

It deliberately has **no LLM step**. The app keeps owning the conversation: each finished user turn
runs through the local conversation engine (`voice/local/localVoiceEngine.ts`
`runLocalVoiceTextTurn` → `sendVoiceTextTurn`), with the same conversation modes, voice agent,
tools, transcript and privacy rules as every other local turn. Only the speech output is swapped:
`sendVoiceTextTurn` takes an optional `VoiceSpeechOutput` (`voice/output/speakAssistantText.ts`),
and the Pipecat adapter's output sends the already-normalized speech text to the runtime instead of
a device or cloud TTS provider.

Turn boundaries come from Pipecat's user aggregator (`LLMUserAggregator`), never from the bridge:
Flux (`flux-general-en`) proposes start and end of turn itself; Nova-3 uses Silero VAD and the
bundled smart-turn model.

## Where it runs

On one of the user's machines, under the daemon, never on the relay server (the relay must not see
plaintext audio or transcripts). The machine is the one hosting the voice conversation: the voice
agent's conversation session in agent mode, the target session otherwise
(`voice/adapters/realtimePipecat/realtimePipecatAdapter.ts`).

## Contracts

| Seam | Owner | Shape |
| --- | --- | --- |
| App → daemon | `packages/protocol/src/daemonVoiceRuntime.ts`, `RPC_METHODS.DAEMON_VOICE_RUNTIME_START/STOP` | Start carries an app-chosen `sessionKey`, the config (user's Deepgram key, STT model, TTS voice, ICE servers) and the WebRTC offer; returns the answer. Stop is by `sessionKey`, so the app can release a runtime whose start it gave up on. |
| Daemon → runtime | `apps/cli/src/daemon/voiceRuntime/voiceRuntimeSessions.ts`, `apps/voice-runtime/happier_voice_runtime/__main__.py` | One JSON line on stdin (`start`, carrying the credential); stdout replies `answer` or `error` (invalid config fields by name, never values), then `ended`. Stop is the canonical process-tree termination; SIGTERM is a clean stop. Closed stdin ends the session, so a dead daemon cannot leave one running. |
| App ↔ runtime | `voice/pipecat/pipecatRuntimeClient.ts`, `apps/voice-runtime/happier_voice_runtime/bridge.py` | Pipecat RTVI on the WebRTC data channel, plus `happier.user_turn` (runtime → app) and `happier.speak {seq, text, final}` / `happier.cancel {seq}` (app → runtime). Interruptions arrive as Pipecat's own RTVI `bot-interrupted`. The client pings at least every 3 seconds or the runtime treats it as gone. |

`seq` numbers each reply. An interruption (the user talking over the runtime, or a cancel of the
newest reply, which may be fully streamed and still playing) stops every reply received so far;
anything that arrives later for one of them is dropped, so a late delta from an aborted agent turn
is never spoken.

## Credentials

Bring-your-own only: the key is a `SecretString` in the top-level `voicePipecat` account setting
(`voicePipecat.deepgram.apiKey`; not under `voice`, see [compatibility](compatibility.md)),
decrypted in the app at call start and sent in the start machine RPC. That RPC is end-to-end
encrypted except on plain Machines, whose deployments trust the server with Machine control content
([encryption](encryption.md)), the same contract every other settings secret follows. The daemon
passes it to the runtime on stdin; it is never put on a command line, in the environment, in logs,
or on disk. A managed (server-minted) mode would
need short-lived Deepgram grants long enough to cover Pipecat's mid-session reconnects and `Bearer`
auth in its Deepgram services; it is not built.

## Platforms

Web (browser WebRTC) only. The Linux desktop webview (WebKitGTK) is built without WebRTC by Ubuntu
and Arch, and native apps need `@livekit/react-native-webrtc` wiring proven on a device; both
report `voice_runtime_unsupported_platform` (`voice/pipecat/pipecatPlatform*.ts`).

## Running it

```bash
cd apps/voice-runtime && uv sync          # Python environment with Pipecat
export HAPPIER_VOICE_RUNTIME_PYTHON="$PWD/.venv/bin/python"   # in the daemon's environment
uv run pytest                              # bridge contract tests
DEEPGRAM_API_KEY=... uv run python scripts/live_roundtrip.py --out /tmp/proof [--stt-model nova-3] [--scenario barge-in]
```

The web end-to-end check is `packages/tests/suites/ui-e2e/voice.pipecat.live.spec.ts` (opt-in,
live Deepgram).
