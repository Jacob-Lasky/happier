import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { VoicePipecatSettings, VoicePipecatSttModel } from '@/sync/domains/settings/voiceSettings';
import { useSetting } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { secretStringFromInput } from '@/sync/encryption/secretSettings';
import { t, type TranslationKeyNoParams } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

const STT_MODEL_OPTIONS: ReadonlyArray<Readonly<{ id: VoicePipecatSttModel; title: string; subtitleKey: TranslationKeyNoParams }>> = [
  { id: 'flux-general-en', title: 'Deepgram Flux', subtitleKey: 'settingsVoice.pipecat.fluxSubtitle' },
  { id: 'nova-3', title: 'Deepgram Nova-3', subtitleKey: 'settingsVoice.pipecat.novaSubtitle' },
];

/** Aura-2 English voices, checked against Deepgram's model list (GET /v1/models) on 2026-11-12. */
const AURA_VOICE_IDS = [
  'aura-2-helena-en',
  'aura-2-thalia-en',
  'aura-2-andromeda-en',
  'aura-2-athena-en',
  'aura-2-luna-en',
  'aura-2-apollo-en',
  'aura-2-arcas-en',
  'aura-2-orion-en',
  'aura-2-draco-en',
  'aura-2-hyperion-en',
] as const;

function auraVoiceName(voiceId: string): string {
  const name = voiceId.replace(/^aura-2-/, '').replace(/-[a-z]{2}$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The speech half of Pipecat voice: the user's Deepgram key, the STT model and the Aura voice. */
export function PipecatSpeechGroup(props: { popoverBoundaryRef?: React.RefObject<any> | null }) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'sttModel' | 'voice'>(null);
  const cfg = useSetting('voicePipecat') as VoicePipecatSettings;
  const applySettings = useApplySettings();
  const setCfg = (next: VoicePipecatSettings) => applySettings({ voicePipecat: next });

  return (
    <ItemGroup title={t('settingsVoice.pipecat.title')} footer={t('settingsVoice.pipecat.footer')}>
      <Item
        title={t('settingsVoice.pipecat.apiKeyTitle')}
        subtitle={t('settingsVoice.pipecat.apiKeyDescription')}
        detail={cfg.deepgram.apiKey ? t('settingsVoice.byo.apiKeySet') : t('settingsVoice.byo.apiKeyNotSet')}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(
              t('settingsVoice.pipecat.apiKeyTitle'),
              t('settingsVoice.pipecat.apiKeyDescription'),
              { inputType: 'secure-text', placeholder: t('settingsVoice.pipecat.apiKeyTitle') },
            );
            if (raw === null) return;
            setCfg({ ...cfg, deepgram: { ...cfg.deepgram, apiKey: secretStringFromInput(raw) } });
          })(), { tag: 'PipecatSpeechGroup.prompt.apiKey' });
        }}
      />
      <DropdownMenu
        open={openMenu === 'sttModel'}
        onOpenChange={(next) => setOpenMenu(next ? 'sttModel' : null)}
        variant="selectable"
        search={false}
        selectedId={cfg.stt.model}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{ title: t('settingsVoice.pipecat.sttModelTitle') }}
        items={STT_MODEL_OPTIONS.map((option) => ({
          id: option.id,
          title: option.title,
          subtitle: t(option.subtitleKey),
          icon: <Icon name="microphone" size={20} color={theme.colors.text.secondary} />,
        }))}
        onSelect={(id) => {
          const option = STT_MODEL_OPTIONS.find((candidate) => candidate.id === id);
          if (option) setCfg({ ...cfg, stt: { ...cfg.stt, model: option.id } });
          setOpenMenu(null);
        }}
      />
      <DropdownMenu
        open={openMenu === 'voice'}
        onOpenChange={(next) => setOpenMenu(next ? 'voice' : null)}
        variant="selectable"
        search={false}
        selectedId={cfg.tts.voice}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{ title: t('settingsVoice.pipecat.voiceTitle') }}
        items={AURA_VOICE_IDS.map((voiceId) => ({
          id: voiceId,
          title: auraVoiceName(voiceId),
          subtitle: voiceId,
          icon: <Icon name="speaker-high" size={20} color={theme.colors.text.secondary} />,
        }))}
        onSelect={(id) => {
          if (id) setCfg({ ...cfg, tts: { ...cfg.tts, voice: id } });
          setOpenMenu(null);
        }}
      />
    </ItemGroup>
  );
}
