import { getOrCreateWebAudioContext } from '@/voice/output/webAudioContext';

/** Streaming PCM audio has a different lifecycle from the local providers' encoded audio files. */
export function createDeepgramAudio(onSpeaking: (speaking: boolean) => void) {
  let input: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let worklet: AudioWorkletNode | null = null;
  let output: AudioContext | null = null;
  const sources = new Set<AudioBufferSourceNode>();
  let nextStart = 0;
  let stopped = false;

  const interrupt = () => {
    for (const source of sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    sources.clear();
    nextStart = 0;
    onSpeaking(false);
  };

  return {
    async start(send: (pcm: ArrayBuffer) => void) {
      stopped = false;
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (stopped) { mic.getTracks().forEach(track => track.stop()); return; }
      stream = mic;
      const context = new AudioContext({ sampleRate: 16000 });
      input = context;
      // The context performs native resampling before the worklet converts mono float PCM to LE int16.
      const url = URL.createObjectURL(new Blob([`
        class DeepgramMicrophone extends AudioWorkletProcessor {
          process(inputs) {
            const samples = inputs[0]?.[0];
            if (samples) {
              const pcm = new ArrayBuffer(samples.length * 2);
              const view = new DataView(pcm);
              for (let i = 0; i < samples.length; i++) {
                const sample = Math.max(-1, Math.min(1, samples[i]));
                view.setInt16(i * 2, sample * (sample < 0 ? 32768 : 32767), true);
              }
              this.port.postMessage(pcm, [pcm]);
            }
            return true;
          }
        }
        registerProcessor('deepgram-microphone', DeepgramMicrophone);
      `], { type: 'application/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (stopped) return;
      worklet = new AudioWorkletNode(context, 'deepgram-microphone');
      worklet.port.onmessage = event => { if (!stopped && event.data instanceof ArrayBuffer) send(event.data); };
      const mute = context.createGain();
      mute.gain.value = 0;
      context.createMediaStreamSource(mic).connect(worklet).connect(mute).connect(context.destination);
      await context.resume();
    },
    play(pcm: ArrayBuffer) {
      output ??= getOrCreateWebAudioContext() as AudioContext | null;
      if (!output) throw new Error('web_audio_unavailable');
      const samples = new DataView(pcm);
      const buffer = output.createBuffer(1, Math.floor(pcm.byteLength / 2), 24000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = samples.getInt16(i * 2, true) / 32768;
      const source = output.createBufferSource();
      source.buffer = buffer;
      source.connect(output.destination);
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        source.disconnect();
        if (sources.size === 0) onSpeaking(false);
      };
      const start = Math.max(output.currentTime, nextStart);
      nextStart = start + buffer.duration;
      onSpeaking(true);
      source.start(start);
    },
    interrupt,
    async stop() {
      stopped = true;
      interrupt();
      worklet?.disconnect();
      worklet = null;
      stream?.getTracks().forEach(track => track.stop());
      stream = null;
      const context = input;
      input = null;
      if (context && context.state !== 'closed') await context.close();
    },
  };
}
