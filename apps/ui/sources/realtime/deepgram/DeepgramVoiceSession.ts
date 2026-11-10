import { z } from 'zod';
import type { VoiceSession, VoiceSessionConfig } from '../types';

export type DeepgramSessionOptions = {
  createSocket: (token: string) => WebSocket;
  audio: { start: (send: (pcm: ArrayBuffer) => void) => Promise<void>; play: (pcm: ArrayBuffer) => void; interrupt: () => void; stop: () => Promise<void> };
  settings: Record<string, unknown>;
  tools: Record<string, (parameters: unknown) => Promise<string>>;
  onMessage: (message: Record<string, unknown>) => void;
  onStatus: (status: 'connecting' | 'connected' | 'disconnected') => void;
  onError: (error: Error) => void;
};

const functionCalls = z.object({ functions: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string(), client_side: z.boolean() })) });
const cancelledCalls = z.object({ functions: z.array(z.object({ id: z.string() })) });

/** Browser wire contract captured against the live API in packages/tests/fixtures/voice. */
export class DeepgramVoiceSession implements VoiceSession {
  private socket: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private removeAbortListener: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private prompt = '';
  private readonly pendingTools = new Set<string>();

  constructor(private readonly options: DeepgramSessionOptions) {}

  async startSession(config: VoiceSessionConfig): Promise<string | null> {
    await this.endSession();
    if (config.signal?.aborted) return null;
    if (!config.token || !config.leaseId) throw new Error('deepgram_missing_grant_or_lease');
    this.prompt = z.object({ agent: z.object({ think: z.object({ prompt: z.string() }).optional() }).optional() }).parse(this.options.settings).agent?.think?.prompt ?? '';
    this.options.onStatus('connecting');
    const socket = this.options.createSocket(config.token);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    const onAbort = () => { void this.endSession(); };
    config.signal?.addEventListener('abort', onAbort, { once: true });
    this.removeAbortListener = () => config.signal?.removeEventListener('abort', onAbort);
    let requestId: string | null = null;
    return new Promise<string>((resolve, reject) => {
      this.rejectStart = reject;
      const fail = (error: Error) => {
        this.options.onError(error);
        void this.endSession();
        reject(error);
      };
      socket.onerror = () => fail(new Error('deepgram_connection_failed'));
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.options.onStatus('disconnected');
        void this.endSession();
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        try {
          if (event.data instanceof ArrayBuffer) {
            this.options.audio.play(event.data);
            return;
          }
          const message = z.record(z.string(), z.unknown()).parse(JSON.parse(String(event.data)));
          this.options.onMessage(message);
          switch (message.type) {
            case 'Welcome':
              requestId = z.string().parse(message.request_id);
              config.onConversationId?.(requestId);
              this.send({ ...this.options.settings, type: 'Settings', tags: [config.leaseId] });
              break;
            case 'SettingsApplied':
              if (!requestId) throw new Error('deepgram_missing_request_id');
              // Deepgram requires KeepAlive every 3–5 seconds when not streaming microphone audio.
              this.keepAlive = setInterval(() => this.send({ type: 'KeepAlive' }), 5000);
              void (async () => {
                if (!config.textOnly) await this.options.audio.start((pcm) => {
                  if (this.socket === socket && socket.readyState === 1) socket.send(pcm);
                });
                if (this.socket !== socket) return;
                this.rejectStart = null;
                this.options.onStatus('connected');
                resolve(requestId!);
              })().catch(() => fail(new Error('deepgram_microphone_failed')));
              break;
            case 'UserStartedSpeaking':
              this.options.audio.interrupt();
              break;
            case 'FunctionCallRequest':
              for (const call of functionCalls.parse(message).functions) {
                if (!call.client_side) continue;
                this.pendingTools.add(call.id);
                void this.runTool(socket, call);
              }
              break;
            case 'FunctionCallCancelled':
              for (const call of cancelledCalls.parse(message).functions) this.pendingTools.delete(call.id);
              break;
            case 'Error':
              fail(new Error(`deepgram_${typeof message.code === 'string' ? message.code : 'api_error'}`));
              break;
          }
        } catch {
          fail(new Error('deepgram_invalid_message'));
        }
      };
    });
  }

  private async runTool(socket: WebSocket, call: { id: string; name: string; arguments: string }): Promise<void> {
    let content: string;
    try {
      const handler = this.options.tools[call.name];
      if (!handler) throw new Error('unknown_tool');
      content = await handler(JSON.parse(call.arguments));
    } catch {
      content = JSON.stringify({ ok: false, error: 'voice_tool_failed' });
    }
    if (this.socket !== socket || !this.pendingTools.delete(call.id)) return;
    this.send({ type: 'FunctionCallResponse', id: call.id, name: call.name, content });
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  async endSession(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.pendingTools.clear();
    this.removeAbortListener?.();
    this.removeAbortListener = null;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.rejectStart?.(new Error('deepgram_session_ended'));
    this.rejectStart = null;
    socket?.close();
    await this.options.audio.stop();
    this.options.onStatus('disconnected');
  }

  sendTextMessage(message: string): void { this.send({ type: 'InjectUserMessage', content: message }); }
  sendContextualUpdate(update: string): void {
    // UpdatePrompt replaces the system prompt; retain the agent's instructions and earlier context.
    this.prompt = [this.prompt, update].filter(Boolean).join('\n\n');
    this.send({ type: 'UpdatePrompt', prompt: this.prompt });
  }
}
