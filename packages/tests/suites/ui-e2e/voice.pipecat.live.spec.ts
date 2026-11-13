/**
 * Live Pipecat voice on web: real server, real daemon running the voice runtime, real Deepgram.
 *
 *   HAPPIER_E2E_PIPECAT_LIVE=1 \
 *   HAPPIER_E2E_DEEPGRAM_API_KEY=<a Deepgram key> \
 *   HAPPIER_VOICE_RUNTIME_PYTHON=<apps/voice-runtime/.venv/bin/python> \
 *   yarn test:ui:e2e suites/ui-e2e/voice.pipecat.live.spec.ts
 *
 * The browser's microphone is a WAV of a spoken request (synthesized with Deepgram). The request
 * must reach the session as a user message, the session's reply must be spoken by the runtime, and
 * the audio the browser received is transcribed again to prove what was said.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { ensureUiFeatureEnabled } from '../../src/testkit/uiE2e/ensureUiFeatureEnabled';

const LIVE = process.env.HAPPIER_E2E_PIPECAT_LIVE === '1';
const DEEPGRAM_API_KEY = process.env.HAPPIER_E2E_DEEPGRAM_API_KEY ?? '';
const RUNTIME_PYTHON = process.env.HAPPIER_VOICE_RUNTIME_PYTHON ?? '';
const SPOKEN_REQUEST = 'Please ask the coding session to run the unit tests.';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const suiteDir = run.testDir('voice-pipecat-live');
const microphoneWavPath = resolve(join(suiteDir, 'microphone.wav'));

test.use({
  permissions: ['microphone'],
  launchOptions: {
    ...(process.env.HAPPIER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.HAPPIER_E2E_CHROMIUM_EXECUTABLE } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${microphoneWavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

async function deepgram(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`https://api.deepgram.com${path}`, {
    ...init,
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Deepgram ${path} failed with ${response.status}`);
  return response;
}

/**
 * The spoken request between short silences. Chrome loops a fake capture file from the moment the
 * microphone is first opened (the permission check), not from when the call connects, so the
 * request repeats every ~15 s and a connected call is sure to hear it.
 */
async function writeMicrophoneWav(path: string): Promise<void> {
  const speech = Buffer.from(await (await deepgram(
    '/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=48000&container=wav',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: SPOKEN_REQUEST }) },
  )).arrayBuffer());
  const pcm = speech.subarray(44);
  const bytesPerSecond = 48_000 * 2;
  const body = Buffer.concat([Buffer.alloc(bytesPerSecond * 2), pcm, Buffer.alloc(bytesPerSecond * 10)]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(bytesPerSecond, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(body.length, 40);
  await writeFile(path, Buffer.concat([header, body]));
}

/** Records the first remote audio track the page receives, i.e. what the runtime said. */
async function installRemoteAudioRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      chunks: [] as Blob[],
      recorder: null as MediaRecorder | null,
      log: [] as string[],
      channel: null as RTCDataChannel | null,
      micTrack: null as MediaStreamTrack | null,
      remoteTrack: null as MediaStreamTrack | null,
    };
    (window as any).__pipecatLive = state;
    const note = (line: string) => state.log.push(`${new Date().toISOString()} ${line}`);
    const Original = window.RTCPeerConnection;
    const Patched = function (this: unknown, config?: RTCConfiguration) {
      const pc = new Original(config);
      note('peer connection created');
      pc.addEventListener('connectionstatechange', () => note(`connection ${pc.connectionState}`));
      const createDataChannel = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (label: string, init?: RTCDataChannelInit) => {
        const channel = createDataChannel(label, init);
        state.channel = channel;
        channel.addEventListener('open', () => note('data channel open'));
        channel.addEventListener('close', () => note('data channel close'));
        channel.addEventListener('message', (event) => {
          const type = typeof event.data === 'string' ? (JSON.parse(event.data) as { type?: string }).type : 'binary';
          note(`recv ${type}`);
        });
        const send = channel.send.bind(channel);
        channel.send = ((data: string) => {
          if (!data.startsWith('ping')) {
            const message = JSON.parse(data) as { type?: string; data?: { t?: string; d?: { text?: string } } };
            const speech = message.data?.t === 'happier.speak' ? ` happier.speak ${JSON.stringify(message.data.d?.text ?? '')}` : '';
            note(`send ${message.type}${speech}`);
          }
          send(data);
        }) as typeof channel.send;
        return channel;
      };
      const addTrack = pc.addTrack.bind(pc);
      pc.addTrack = (track: MediaStreamTrack, ...streams: MediaStream[]) => {
        note(`add ${track.kind} track enabled=${track.enabled} muted=${track.muted} state=${track.readyState}`);
        if (track.kind === 'audio') state.micTrack = track;
        track.addEventListener('mute', () => note('mic track muted'));
        track.addEventListener('ended', () => note('mic track ended'));
        return addTrack(track, ...streams);
      };
      pc.addEventListener('track', (event) => {
        if (event.track.kind !== 'audio' || state.recorder) return;
        state.remoteTrack = event.track;
        const recorder = new MediaRecorder(new MediaStream([event.track]), { mimeType: 'audio/webm;codecs=opus' });
        recorder.ondataavailable = (chunk) => state.chunks.push(chunk.data);
        recorder.start(500);
        state.recorder = recorder;
      });
      return pc;
    } as unknown as typeof RTCPeerConnection;
    Patched.prototype = Original.prototype;
    window.RTCPeerConnection = Patched;
  });
}

async function readClientLog(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as any).__pipecatLive?.log ?? []) as string[]);
}

/**
 * Has the runtime speak `text` straight from the data channel (the mic muted so the looping request
 * cannot barge in) and returns the audio the page received for it alone.
 */
async function recordRuntimeSpeaking(page: Page, text: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (sentence) => {
    const state = (window as any).__pipecatLive as {
      channel: RTCDataChannel | null;
      micTrack: MediaStreamTrack | null;
      remoteTrack: MediaStreamTrack | null;
      log: string[];
    };
    if (!state.channel || !state.remoteTrack) return '';
    if (state.micTrack) state.micTrack.enabled = false;
    // Let speech already in flight (a reply to a looped request) drain before recording.
    const quiet = () => {
      const last = [...state.log].reverse().find((line) => /bot-(started|stopped)-speaking/.test(line));
      return !last || last.includes('bot-stopped-speaking');
    };
    for (let i = 0; i < 100 && !quiet(); i += 1) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500));
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(new MediaStream([state.remoteTrack]), { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (chunk) => chunks.push(chunk.data);
    recorder.start(250);
    const before = state.log.length;
    state.channel.send(JSON.stringify({
      label: 'rtvi-ai',
      type: 'client-message',
      id: 'e2e-speak',
      data: { t: 'happier.speak', d: { seq: 100000, text: sentence, final: true } },
    }));
    for (let i = 0; i < 200; i += 1) {
      if (state.log.slice(before).some((line) => line.includes('bot-stopped-speaking'))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1000));
    await new Promise<void>((done) => {
      recorder.onstop = () => done();
      recorder.stop();
    });
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, text);
  return Buffer.from(base64, 'base64');
}

async function readRemoteAudio(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const state = (window as any).__pipecatLive as { chunks: Blob[]; recorder: MediaRecorder | null };
    if (!state.recorder) return '';
    if (state.recorder.state !== 'inactive') {
      await new Promise<void>((done) => {
        state.recorder!.onstop = () => done();
        state.recorder!.stop();
      });
    }
    const bytes = new Uint8Array(await new Blob(state.chunks).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

test.describe('ui e2e: Pipecat voice (live)', () => {
  test.skip(!LIVE, 'live Deepgram test; set HAPPIER_E2E_PIPECAT_LIVE=1');
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    if (!DEEPGRAM_API_KEY || !RUNTIME_PYTHON) throw new Error('set HAPPIER_E2E_DEEPGRAM_API_KEY and HAPPIER_VOICE_RUNTIME_PYTHON');
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000',
      HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });
    await writeMicrophoneWav(microphoneWavPath);
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });
    ui = await startUiWeb({ testDir: suiteDir, env: { ...uiWebEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl } });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('speaks a request to the session and hears the reply', async ({ page }, testInfo) => {
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    const uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    const diagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 'speak-and-hear'));
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    await mkdir(testDir, { recursive: true });
    await installRemoteAudioRecorder(page);

    try {
      await test.step('create an account and connect a daemon that has the voice runtime', async () => {
        await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
        // The daemon and its runtime get the key only the way users' machines do: inside the start
        // RPC. Nothing spawned here inherits it from this test's environment.
        const { HAPPIER_E2E_DEEPGRAM_API_KEY: _key, ...parentEnv } = process.env;
        const cliEnv = { ...parentEnv, CI: '1', HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_VARIANT: 'dev' };
        const cliLogin = await startCliAuthLoginForTerminalConnect({ testDir, cliHomeDir, serverUrl: server!.baseUrl, webappUrl: uiBaseUrl, env: cliEnv });
        try {
          await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
          await page.getByTestId('terminal-connect-approve').click();
          await cliLogin.waitForSuccess();
        } finally {
          await cliLogin.stop().catch(() => {});
        }
        daemon = await startTestDaemon({
          testDir,
          happyHomeDir: cliHomeDir,
          env: {
            ...cliEnv,
            HAPPIER_HOME_DIR: cliHomeDir,
            HAPPIER_SERVER_URL: server!.baseUrl,
            HAPPIER_WEBAPP_URL: uiBaseUrl,
            HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
            HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
            HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
            HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
            HAPPIER_VOICE_RUNTIME_PYTHON: RUNTIME_PYTHON,
            HAPPIER_VOICE_RUNTIME_LOG_LEVEL: process.env.HAPPIER_VOICE_RUNTIME_LOG_LEVEL ?? 'INFO',
          },
        });
      });

      const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir });
      const session = await test.step('create a session', async () =>
        createSessionFromNewSessionComposer({ page, uiBaseUrl, machineId, prompt: 'hello', readiness: 'first-turn-reload-safe' }));

      await test.step('choose Pipecat voice and enter the Deepgram key in Settings', async () => {
        await ensureUiFeatureEnabled({ page, baseUrl: uiBaseUrl, featureId: 'voice' });
        await page.goto(`${uiBaseUrl}/settings/voice`, { waitUntil: 'domcontentloaded' });
        await page.getByText('Pipecat realtime voice', { exact: true }).click();
        await page.getByText('Deepgram API key', { exact: true }).first().click();
        await page.getByTestId('web-prompt-input').fill(DEEPGRAM_API_KEY);
        await page.getByTestId('web-prompt-confirm').click();
        await expect(page.getByText('Pipecat speech', { exact: true })).toBeVisible();
        await page.screenshot({ path: join(testDir, 'settings-voice-pipecat.png'), fullPage: true });
      });

      const timeline: Array<{ at: string; step: string }> = [];
      const mark = (step: string) => timeline.push({ at: new Date().toISOString(), step });
      await test.step('start voice in the session and speak the request', async () => {
        await page.goto(session.sessionHref, { waitUntil: 'domcontentloaded' });
        mark('voice-button-click');
        // The composer's voice button keeps this label while a call runs (its icon becomes stop).
        await page.getByRole('button', { name: 'Voice Assistant' }).first().click();
        // Flux's transcript of the spoken request arrives in the session as the user's message.
        await expect(page.getByText(/run the unit tests/i).first()).toBeVisible({ timeout: 120_000 });
        mark('spoken-request-in-transcript');
      });

      await test.step('hear the session reply spoken back', async () => {
        await expect(page.getByText(/FAKE_CLAUDE_OK_2/).first()).toBeVisible({ timeout: 90_000 });
        mark('session-reply-in-transcript');
        // Let the runtime finish speaking the reply before collecting what the page received.
        await page.waitForTimeout(8_000);
        await page.screenshot({ path: join(testDir, 'session-voice-pipecat.png'), fullPage: true });
        const audio = await readRemoteAudio(page);
        await writeFile(join(testDir, 'bot-audio.webm'), audio);
        expect(audio.length).toBeGreaterThan(1_000);
        const result = await (await deepgram('/v1/listen?model=nova-3&smart_format=true', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm' },
          body: new Uint8Array(audio),
        })).json() as { results: { channels: Array<{ alternatives: Array<{ transcript: string }> }> } };
        const transcript = result.results.channels[0]?.alternatives[0]?.transcript ?? '';
        const spokenByRuntime = (await readClientLog(page)).filter((line) => line.includes('happier.speak'));
        await writeFile(join(testDir, 'proof.json'), JSON.stringify({
          spokenRequest: SPOKEN_REQUEST,
          sessionId: session.sessionId,
          botAudioBytes: audio.length,
          botAudioTranscript: transcript,
          spokenByRuntime,
          timeline,
        }, null, 2));
        // The session's reply went to the runtime to be spoken, exactly as the session wrote it...
        expect(spokenByRuntime.some((line) => line.includes('"FAKE_CLAUDE_OK_2"'))).toBe(true);
        // ...and the runtime's speech of it reached the browser. The fake agent's code token is a poor
        // sample for checking TTS word by word (STT reads it back as "Fake Claude OK", "Claudio", "The
        // Glatio"), so only speech is required here; the next step checks a natural sentence exactly.
        expect(transcript.trim().length).toBeGreaterThan(0);
      });

      await test.step('hear a natural sentence spoken by the runtime, word for word', async () => {
        // Ordinary words only: STT may split a coined name ("Pipecat" came back as "pipe cat"), which is
        // not what this step checks.
        const sentence = 'This is Happier speaking through the open source voice runtime on your machine.';
        const audio = await recordRuntimeSpeaking(page, sentence);
        await writeFile(join(testDir, 'sentence-audio.webm'), audio);
        const result = await (await deepgram('/v1/listen?model=nova-3&smart_format=true', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm' },
          body: new Uint8Array(audio),
        })).json() as { results: { channels: Array<{ alternatives: Array<{ transcript: string }> }> } };
        const heard = result.results.channels[0]?.alternatives[0]?.transcript ?? '';
        await writeFile(join(testDir, 'sentence-proof.json'), JSON.stringify({ sentence, heard }, null, 2));
        const normalize = (value: string) => value.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
        // Deepgram formats "open source" as "open-source" either way; compare words.
        expect(normalize(heard)).toBe(normalize(sentence));
      });

      await writeFile(join(testDir, 'browser-diagnostics.md'), diagnostics());
      await test.step('end the call', async () => {
        await page.getByRole('button', { name: 'Voice Assistant' }).first().click();
        mark('voice-button-click-to-end');
        await writeFile(join(testDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
      });
    } catch (error) {
      await testInfo.attach('browser-diagnostics.md', { body: diagnostics(), contentType: 'text/markdown' });
      await writeFile(join(testDir, 'browser-diagnostics.md'), diagnostics()).catch(() => {});
      await writeFile(join(testDir, 'client-log.txt'), (await readClientLog(page).catch(() => [])).join('\n')).catch(() => {});
      await page.screenshot({ path: join(testDir, 'failure.png'), fullPage: true }).catch(() => {});
      throw error;
    }
  });
});
