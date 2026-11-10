import { describe, expect, it, vi } from 'vitest';
import { DeepgramVoiceSession } from './DeepgramVoiceSession';

function fixture() {
  // WebSocket and audio are the real browser boundaries.
  const socket = { readyState: 1, binaryType: '', onmessage: null as ((event: { data: string }) => void) | null, onclose: null as (() => void) | null, onerror: null as (() => void) | null, send: vi.fn(), close: vi.fn(() => socket.onclose?.()) };
  const audio = { start: vi.fn(async () => {}), play: vi.fn(), interrupt: vi.fn(), stop: vi.fn(async () => {}) };
  const tool = vi.fn<(args: unknown) => Promise<string>>();
  const session = new DeepgramVoiceSession({ createSocket: () => socket as unknown as WebSocket, audio, settings: { agent: { language: 'en', think: { prompt: 'Keep the tool and privacy instructions.' } } }, tools: { lookup: tool }, onMessage: vi.fn(), onStatus: vi.fn(), onError: vi.fn() });
  const receive = (message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) });
  return { socket, audio, tool, session, receive };
}

describe('Deepgram voice wire lifecycle', () => {
  it('initializes with the lease tag, resolves the request id, and maps context and text frames', async () => {
    const f = fixture();
    const starting = f.session.startSession({ sessionId: 's1', token: 'grant', leaseId: 'lease1', textOnly: true });
    await Promise.resolve();
    await Promise.resolve();
    f.receive({ type: 'Welcome', request_id: 'request1' });
    expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ agent: { language: 'en', think: { prompt: 'Keep the tool and privacy instructions.' } }, type: 'Settings', tags: ['lease1'] }));
    f.receive({ type: 'SettingsApplied' });
    expect(await starting).toBe('request1');
    f.session.sendContextualUpdate('new context');
    f.session.sendTextMessage('hello');
    expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'UpdatePrompt', prompt: 'Keep the tool and privacy instructions.\n\nnew context' }));
    expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'InjectUserMessage', content: 'hello' }));
    await f.session.endSession();
  });

  it('returns real handler output, flushes playback on barge-in, and drops a cancelled late result', async () => {
    const f = fixture();
    let resolveLate!: (value: string) => void;
    f.tool.mockResolvedValueOnce('first result').mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }));
    const starting = f.session.startSession({ sessionId: 's1', token: 'grant', leaseId: 'lease1', textOnly: true });
    await Promise.resolve();
    await Promise.resolve();
    f.receive({ type: 'Welcome', request_id: 'request1' });
    f.receive({ type: 'SettingsApplied' });
    await starting;
    f.receive({ type: 'FunctionCallRequest', functions: [{ id: 'f1', name: 'lookup', arguments: '{"label":"first"}', client_side: true }] });
    await vi.waitFor(() => expect(f.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'FunctionCallResponse', id: 'f1', name: 'lookup', content: 'first result' })));
    f.receive({ type: 'FunctionCallRequest', functions: [{ id: 'f2', name: 'lookup', arguments: '{}', client_side: true }] });
    f.receive({ type: 'UserStartedSpeaking' });
    f.receive({ type: 'FunctionCallCancelled', functions: [{ id: 'f2', name: 'lookup' }] });
    resolveLate('late result');
    await Promise.resolve();
    expect(f.audio.interrupt).toHaveBeenCalled();
    expect(f.socket.send.mock.calls.map(([frame]) => JSON.parse(frame)).filter(m => m.type === 'FunctionCallResponse').map(m => m.id)).toEqual(['f1']);
    await f.session.endSession();
  });
});
