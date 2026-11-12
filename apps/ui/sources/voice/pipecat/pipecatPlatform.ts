import type { PipecatPlatform } from './pipecatRuntimeClient';

/**
 * Native apps are not wired yet: they need react-native-webrtc's RTCPeerConnection (already shipped
 * as @livekit/react-native-webrtc) proven on a device first. Until then Pipecat voice reports that
 * this platform is unsupported instead of failing midway.
 */
export function resolvePipecatPlatform(): PipecatPlatform | null {
  return null;
}
