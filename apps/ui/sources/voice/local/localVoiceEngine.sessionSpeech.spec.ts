import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getStorage, registerLocalVoiceEngineHarnessHooks, submitMessage } from './localVoiceEngine.testHarness';

let localVoiceEngine: typeof import('./localVoiceEngine');

/** Turns whose speech is captured and spoken by the voice session itself (the Pipecat runtime). */
describe('local voice engine with a session speech output', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        localVoiceEngine = await import('./localVoiceEngine');
    }, 180_000);

    async function useDirectSessionTurns(autoSpeakReplies: boolean) {
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...voice,
                    providerId: 'realtime_pipecat',
                    adapters: {
                        ...voice.adapters,
                        local_conversation: {
                            ...voice.adapters.local_conversation,
                            conversationMode: 'direct_session',
                            tts: { ...voice.adapters.local_conversation.tts, autoSpeakReplies },
                        },
                    },
                },
            },
        });
        return storage;
    }

    function replyArrives(storage: Awaited<ReturnType<typeof getStorage>>) {
        storage.__setState({
            sessionMessages: {
                s1: { messages: [{ id: 'm1', kind: 'agent-text', text: 'Hi there', createdAt: Date.now() + 60_000 }] },
            },
        });
        storage.__notify();
    }

    it('speaks the reply through the session output even when the hidden local auto-speak preference is off', async () => {
        const storage = await useDirectSessionTurns(false);
        submitMessage.mockImplementationOnce(() => replyArrives(storage));
        const speak = vi.fn(async () => {});

        await localVoiceEngine.runLocalVoiceTextTurn({ sessionId: 's1', text: 'hello', speechOutput: { speak } });

        expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hi there' }));
    });

    it('does not speak a reply that arrives after the user interrupted the turn', async () => {
        const storage = await useDirectSessionTurns(true);
        const speak = vi.fn(async () => {});

        const turn = localVoiceEngine.runLocalVoiceTextTurn({ sessionId: 's1', text: 'hello', speechOutput: { speak } });
        await vi.waitFor(() => expect(submitMessage).toHaveBeenCalled());
        localVoiceEngine.interruptLocalVoicePlayback();
        replyArrives(storage);
        await turn;

        expect(speak).not.toHaveBeenCalled();
    });
});
