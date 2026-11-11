import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DeepgramVoiceSession } from './DeepgramVoiceSession';

function fixture() {
  // WebSocket and audio are the real browser boundaries.
  const socket = { readyState: 1, binaryType: '', onmessage: null as ((event: { data: string | ArrayBuffer }) => void) | null, onclose: null as (() => void) | null, onerror: null as (() => void) | null, send: vi.fn(), close: vi.fn(() => socket.onclose?.()) };
  const audio = { start: vi.fn(async () => {}), play: vi.fn(), interrupt: vi.fn(), stop: vi.fn(async () => {}) };
  const tool = vi.fn<(args: unknown) => Promise<string>>();
  const onError = vi.fn();
  const session = new DeepgramVoiceSession({ createSocket: () => socket as unknown as WebSocket, audio, settings: { agent: { think: { prompt: 'Keep the tool and privacy instructions.' } } }, tools: { lookup: tool }, onMessage: vi.fn(), onStatus: vi.fn(), onError });
  const receive = (message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) });
  return { socket, audio, tool, session, receive, onError };
}

function sentFrames(f: ReturnType<typeof fixture>): Array<Record<string, unknown>> {
  return f.socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as Record<string, unknown>);
}

describe('Deepgram voice wire lifecycle', () => {
  it('initializes with the lease tag, resolves the request id, and maps context and text frames', async () => {
    const f = fixture();
    const starting = f.session.startSession({ sessionId: 's1', token: 'grant', leaseId: 'lease1', textOnly: true });
    await Promise.resolve();
    await Promise.resolve();
    f.receive({ type: 'Welcome', request_id: 'request1' });
    expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ agent: { think: { prompt: 'Keep the tool and privacy instructions.' } }, type: 'Settings', tags: ['lease1'] }));
    f.receive({ type: 'SettingsApplied' });
    expect(await starting).toBe('request1');
    f.session.sendContextualUpdate('new context');
    f.session.sendTextMessage('hello');
    // Deepgram appends UpdatePrompt to the active prompt (measured live 2026-11-10), so only the delta is sent.
    expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'UpdatePrompt', prompt: 'new context' }));
    expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'InjectUserMessage', content: 'hello' }));
    await f.session.endSession();
  });

  it('replays the live 2026-11-10 capture: real handler output, barge-in flush, and a cancelled late result dropped', async () => {
    const capture = JSON.parse(readFileSync(new URL('../../../../../packages/tests/fixtures/voice/deepgram-session-2026-11-10.json', import.meta.url), 'utf8')) as { frames: Array<{ direction: string; message: Record<string, unknown> }> };
    const serverFrames = capture.frames.filter((frame) => frame.direction === 'server').map((frame) => frame.message);
    const calls = serverFrames.filter((m) => m.type === 'FunctionCallRequest').flatMap((m) => (m.functions as Array<{ id: string }>));
    const f = fixture();
    let resolveLate!: (value: string) => void;
    f.tool.mockResolvedValueOnce('first result').mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }));
    const session = new DeepgramVoiceSession({ createSocket: () => f.socket as unknown as WebSocket, audio: f.audio, settings: {}, tools: { lookup_status: f.tool }, onMessage: vi.fn(), onStatus: vi.fn(), onError: f.onError });
    const starting = session.startSession({ sessionId: 's1', token: 'grant', leaseId: 'lease1', textOnly: true });
    await vi.waitFor(() => expect(f.socket.onmessage).not.toBeNull());
    for (const message of serverFrames) {
      if (message.type === 'binary') f.socket.onmessage?.({ data: new ArrayBuffer(Number(message.bytes)) });
      else f.receive(message);
      if (message.type === 'SettingsApplied') await starting;
      if (message.type === 'FunctionCallRequest') await vi.waitFor(() => expect(f.tool).toHaveBeenCalled());
    }
    resolveLate('late result');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.onError).not.toHaveBeenCalled();
    expect(sentFrames(f).find((m) => m.type === 'Settings')).toMatchObject({ tags: ['lease1'] });
    expect(sentFrames(f).filter((m) => m.type === 'FunctionCallResponse')).toEqual([{ type: 'FunctionCallResponse', id: calls[0].id, name: 'lookup_status', content: 'first result' }]);
    expect(f.audio.play).toHaveBeenCalledTimes(serverFrames.filter((m) => m.type === 'binary').length);
    expect(f.audio.interrupt).toHaveBeenCalled();
    await session.endSession();
  });
});
