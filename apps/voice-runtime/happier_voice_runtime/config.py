"""Start configuration the daemon hands the runtime on stdin.

The credential arrives here and nowhere else: never on argv or in the environment, so it is not
visible in a process listing and does not leak into child processes. It is held in memory only.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DeepgramCredential(_Strict):
    # `api_key` is a user's own key (BYO). Managed (server-minted, short-lived) grants are a later
    # mode; they need `Bearer` auth, which Pipecat's Deepgram services do not send today.
    kind: Literal["api_key"]
    value: SecretStr = Field(min_length=1)


class SttConfig(_Strict):
    provider: Literal["deepgram"] = "deepgram"
    # `flux-*` models find their own turn boundaries; `nova-3*` models need local VAD.
    model: str = "flux-general-en"
    language: str | None = None


class TtsConfig(_Strict):
    provider: Literal["deepgram"] = "deepgram"
    voice: str = "aura-2-helena-en"


class IceServer(_Strict):
    urls: list[str] = Field(min_length=1)
    username: str | None = None
    credential: SecretStr | None = None


class RuntimeConfig(_Strict):
    credential: DeepgramCredential
    stt: SttConfig = SttConfig()
    tts: TtsConfig = TtsConfig()
    ice_servers: list[IceServer] = Field(default_factory=list)

    def stt_uses_flux(self) -> bool:
        return self.stt.model.startswith("flux-")
