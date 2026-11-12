"""Contract tests for the app <-> bot seam (bridge.py), through Pipecat's own pipeline harness."""

from __future__ import annotations

from typing import Any

import pytest
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator, LLMUserAggregatorParams
from pipecat.processors.frameworks.rtvi import RTVIClientMessageFrame, RTVIServerMessageFrame
from pipecat.tests.utils import run_test
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

from happier_voice_runtime.bridge import HappierTurnBridge


def transcription(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text, "user", "2026-11-12T00:00:00Z", finalized=True)


def speak(seq: int, text: str, final: bool = False) -> RTVIClientMessageFrame:
    return RTVIClientMessageFrame(
        msg_id=f"m{seq}", type="happier.speak", data={"seq": seq, "text": text, "final": final}
    )


def cancel(seq: int) -> RTVIClientMessageFrame:
    return RTVIClientMessageFrame(msg_id=f"c{seq}", type="happier.cancel", data={"seq": seq})


def server_messages(frames: Any) -> list[dict[str, Any]]:
    return [f.data for f in frames if isinstance(f, RTVIServerMessageFrame)]


def spoken(frames: Any) -> list[str]:
    return [f.text for f in frames if isinstance(f, LLMTextFrame)]


async def run(frames: list[Any]) -> tuple[Any, Any]:
    return await run_test(HappierTurnBridge(), frames_to_send=frames)


def finished_turn(*texts: str) -> LLMContextFrame:
    return LLMContextFrame(context=LLMContext(messages=[{"role": "user", "content": t} for t in texts]))


@pytest.mark.asyncio
async def test_finished_turn_becomes_one_user_turn_message_and_goes_no_further() -> None:
    down, _ = await run([finished_turn("run the tests")])
    assert server_messages(down) == [{"type": "happier.user_turn", "text": "run the tests"}]
    assert not any(isinstance(f, LLMContextFrame) for f in down)


@pytest.mark.asyncio
async def test_speculative_and_empty_turns_are_not_sent() -> None:
    speculative = finished_turn("maybe")
    speculative.speculation = True
    down, _ = await run([speculative, finished_turn()])
    assert server_messages(down) == []


@pytest.mark.asyncio
async def test_aggregator_and_bridge_send_the_whole_turn_once() -> None:
    # The stop proposal is a system frame and overtakes queued transcriptions; the aggregator
    # must still deliver both finals of the turn, once.
    stage = Pipeline(
        [
            LLMUserAggregator(
                LLMContext(),
                params=LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None),
            ),
            HappierTurnBridge(),
        ]
    )
    down, _ = await run_test(
        stage,
        frames_to_send=[
            ProposedUserStartedSpeakingFrame(),
            transcription("run the"),
            transcription("tests"),
            ProposedUserStoppedSpeakingFrame(),
        ],
    )
    assert server_messages(down) == [{"type": "happier.user_turn", "text": "run the tests"}]


@pytest.mark.asyncio
async def test_speak_deltas_become_one_tts_response() -> None:
    down, _ = await run([speak(0, "Hello "), speak(0, "there.", final=True)])
    kinds = [type(f) for f in down if isinstance(f, (LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame))]
    assert kinds == [LLMFullResponseStartFrame, LLMTextFrame, LLMTextFrame, LLMFullResponseEndFrame]
    assert spoken(down) == ["Hello ", "there."]


@pytest.mark.asyncio
async def test_cancelled_response_drops_late_deltas() -> None:
    down, _ = await run([speak(3, "Working on "), cancel(3), speak(3, "it now.", final=True)])
    assert spoken(down) == ["Working on "]
    assert not any(isinstance(f, LLMFullResponseEndFrame) for f in down)


@pytest.mark.asyncio
async def test_barge_in_drops_the_rest_of_every_reply_received_so_far() -> None:
    down, _ = await run(
        [
            speak(1, "A long answer "),
            InterruptionFrame(),
            speak(1, "that keeps going.", final=True),
            speak(2, "New answer.", final=True),
        ]
    )
    assert spoken(down) == ["A long answer ", "New answer."]
    # Pipecat reports the interruption to the app itself (RTVI bot-interrupted); the bridge adds none.
    assert server_messages(down) == []


@pytest.mark.asyncio
async def test_messages_without_a_valid_seq_are_ignored() -> None:
    down, _ = await run(
        [RTVIClientMessageFrame(msg_id="x", type="happier.speak", data={"seq": True, "text": "no", "final": True})]
    )
    assert spoken(down) == []


@pytest.mark.asyncio
async def test_cancel_stops_a_fully_streamed_reply_whose_audio_may_still_play() -> None:
    down, _ = await run([speak(4, "A complete answer.", final=True), cancel(4), speak(4, "late", final=True)])
    assert any(isinstance(f, InterruptionFrame) for f in down)
    assert spoken(down) == ["A complete answer."]


@pytest.mark.asyncio
async def test_cancel_of_an_older_reply_does_not_interrupt_a_newer_one() -> None:
    down, _ = await run([speak(5, "Old.", final=True), speak(6, "Newer reply.", final=True), cancel(5)])
    assert not any(isinstance(f, InterruptionFrame) for f in down)
