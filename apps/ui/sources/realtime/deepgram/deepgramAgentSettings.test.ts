import { describe, expect, it } from 'vitest';
import { buildDeepgramAgentSettings } from './deepgramAgentSettings';

describe('buildDeepgramAgentSettings', () => {
  it('omits the deprecated agent.language that Deepgram rejects for non-English preferences', () => {
    const settings = buildDeepgramAgentSettings({ prompt: 'Be brief.', functions: [] });
    expect(settings.agent).not.toHaveProperty('language');
    expect(settings.agent.think).toMatchObject({ prompt: 'Be brief.', functions: [] });
  });
});
