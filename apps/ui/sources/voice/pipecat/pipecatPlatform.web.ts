import type { PipecatPlatform } from './pipecatRuntimeClient';

/**
 * Browser WebRTC. Null where the webview has no WebRTC: WebKitGTK (the Linux desktop app) is
 * built without it by Ubuntu and Arch, whose builds leave ENABLE_WEB_RTC at its upstream default (off).
 */
export function resolvePipecatPlatform(): PipecatPlatform | null {
  if (typeof RTCPeerConnection !== 'function' || !navigator.mediaDevices?.getUserMedia) return null;
  return {
    createPeerConnection: (config) => new RTCPeerConnection(config),
    getMicrophone: () =>
      navigator.mediaDevices.getUserMedia({
        // The browser cancels the runtime's own voice from the microphone, so it does not
        // interrupt itself through the speakers.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
    playRemoteAudio: (stream) => {
      const element = new Audio();
      element.autoplay = true;
      element.srcObject = stream;
      void element.play().catch(() => undefined);
      return () => {
        element.pause();
        element.srcObject = null;
      };
    },
  };
}
