import { describe, expect, it } from 'vitest';

import { createBuiltinVoiceAdapters } from './registerBuiltinVoiceAdapters';

describe('createBuiltinVoiceAdapters', () => {
  it('returns each built-in provider once in canonical order', () => {
    const ids = createBuiltinVoiceAdapters().map((adapter) => adapter.id);

    expect(ids).toEqual([
      'realtime_elevenlabs',
      'realtime_deepgram',
      'local_direct',
      'local_conversation',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
