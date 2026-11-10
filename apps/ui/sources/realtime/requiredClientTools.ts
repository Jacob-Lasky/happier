import { actionSpecToVoiceClientToolParameters, describeActionForVoiceTool, type JsonSchemaObject } from '@happier-dev/protocol';
import {
    resolveDisabledVoiceActionIdsFromState,
    resolveEnabledVoiceToolActionSpecsFromState,
} from '@/voice/tools/resolveDisabledVoiceActionIds';

export type RequiredVoiceClientToolSpec = Readonly<{
    name: string;
    description: string;
    parameters: JsonSchemaObject;
}>;

export function resolveRequiredVoiceClientTools(state: Readonly<{ settings?: unknown }>): RequiredVoiceClientToolSpec[] {
    const enabledSpecs = resolveEnabledVoiceToolActionSpecsFromState(state);
    const disabledActionIds = resolveDisabledVoiceActionIdsFromState(state);
    const availableActionIds = enabledSpecs.map((spec) => spec.id);
    return enabledSpecs
        .map((spec) => {
            const name = String(spec.bindings?.voiceClientToolName ?? '').trim();
            const parameters = actionSpecToVoiceClientToolParameters(spec, { disabledActionIds, availableActionIds });
            return {
                name,
                description: describeActionForVoiceTool(spec).trim(),
                parameters,
            };
        });
}
