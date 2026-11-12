"""Builds the realtime voice pipeline for one session.

transport.input -> Deepgram STT -> user aggregator -> HappierTurnBridge -> Deepgram TTS -> transport.output

There is deliberately no LLM: the Happier app runs the conversation and streams the reply back
through the bridge (see bridge.py).
"""

from __future__ import annotations

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.transports.base_transport import BaseTransport
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

from .bridge import HappierTurnBridge
from .config import RuntimeConfig


def build_turn_stage(config: RuntimeConfig) -> list[FrameProcessor]:
    """STT plus the user aggregator, which owns turn boundaries and collects each turn's text."""
    api_key = config.credential.value.get_secret_value()
    if config.stt_uses_flux():
        from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService

        # Flux reports StartOfTurn/EndOfTurn itself, so its proposals are the only turn signal:
        # no local VAD or smart-turn model second-guessing it.
        stt: FrameProcessor = DeepgramFluxSTTService(
            api_key=api_key, settings=DeepgramFluxSTTService.Settings(model=config.stt.model)
        )
        params = LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None)
    else:
        # Imported only here: Silero loads onnxruntime, which a Flux session never needs.
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from pipecat.services.deepgram.stt import DeepgramSTTService

        stt = DeepgramSTTService(
            api_key=api_key,
            settings=DeepgramSTTService.Settings(model=config.stt.model, language=config.stt.language),
        )
        # Pipecat's default strategies: VAD or a transcript starts a turn, the bundled smart-turn
        # model ends it.
        params = LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer(), empty_user_turn=None)
    return [stt, LLMUserAggregator(LLMContext(), params=params)]


def build_pipeline_task(config: RuntimeConfig, transport: BaseTransport) -> PipelineTask:
    tts = DeepgramTTSService(
        api_key=config.credential.value.get_secret_value(),
        settings=DeepgramTTSService.Settings(voice=config.tts.voice),
    )
    pipeline = Pipeline(
        [
            transport.input(),
            *build_turn_stage(config),
            HappierTurnBridge(),
            tts,
            transport.output(),
        ]
    )
    # RTVI is added by the task itself (enable_rtvi defaults on): it carries the bridge's messages
    # and the standard transcription/speaking events over the transport's data channel.
    return PipelineTask(pipeline, params=PipelineParams(enable_metrics=True))
