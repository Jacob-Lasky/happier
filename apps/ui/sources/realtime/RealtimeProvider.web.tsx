import React from 'react';
import { RealtimeDeepgramVoiceSession } from './RealtimeDeepgramVoiceSession.web';
import { VoiceSessionRuntime } from '@/voice/session/VoiceSessionRuntime';
import { resolveRealtimeVoiceSessionComponent } from './resolveRealtimeVoiceSessionComponent';

const ResolvedRealtimeVoiceSession = resolveRealtimeVoiceSessionComponent('web');

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <>
            {ResolvedRealtimeVoiceSession ? <ResolvedRealtimeVoiceSession /> : null}
            <RealtimeDeepgramVoiceSession />
            <VoiceSessionRuntime />
            {children}
        </>
    );
};
