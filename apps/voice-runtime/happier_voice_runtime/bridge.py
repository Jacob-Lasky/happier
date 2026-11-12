"""The processor that stands where an LLM would stand in a Pipecat pipeline.

The Happier app owns the conversation: it runs the voice agent turn, its tools and its transcript.
Pipecat's user aggregator, upstream of this processor, owns deciding when a user turn ends and
collecting its transcript; it hands the finished turn over as an ``LLMContextFrame``. This processor
only moves text across the app seam over RTVI messages:

- bot -> app: ``{"type": "happier.user_turn", "text": ...}`` once per finished user turn.
  Interruptions need no message of their own: Pipecat already reports each one to the app (RTVI
  ``bot-interrupted``).
- app -> bot: client message ``happier.speak`` with ``{"seq": n, "text": ..., "final": bool}``
  streams a reply for TTS, and ``happier.cancel`` with ``{"seq": n}`` stops reply ``n``.

``seq`` is a per-session reply counter the app increases for every reply. An interruption (the
user talking over the bot, or a cancel of the newest reply) stops every reply received so far,
including one fully streamed whose audio is still playing; anything that arrives later for one of
those replies is dropped, so a late delta from an aborted agent turn can never be spoken.
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIClientMessageFrame, RTVIServerMessageFrame

SPEAK_MESSAGE = "happier.speak"
CANCEL_MESSAGE = "happier.cancel"
USER_TURN_EVENT = "happier.user_turn"


def _read_seq(data: Any) -> int | None:
    seq = data.get("seq") if isinstance(data, dict) else None
    return seq if isinstance(seq, int) and not isinstance(seq, bool) and seq >= 0 else None


def _take_user_text(context: LLMContext) -> str:
    """The text of the turn just finished, emptying the context so the next turn starts clean.

    The app keeps the conversation history; the bot needs none of it, and an emptied context means
    an aggregator frame with no new user message (an empty turn) yields no text.
    """
    parts: list[str] = []
    for message in context.get_messages():
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(p["text"] for p in content if isinstance(p, dict) and isinstance(p.get("text"), str))
    context.set_messages([])
    return " ".join(part.strip() for part in parts if part.strip())


class HappierTurnBridge(FrameProcessor):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # The reply whose text is still arriving from the app.
        self._streaming_seq: int | None = None
        self._newest_seq = -1
        # Replies up to this seq are finished or interrupted: later text for them is dropped.
        self._closed_through_seq = -1
        # Replies up to this seq have been interrupted already.
        self._interrupted_through_seq = -1

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, RTVIClientMessageFrame) and frame.type in (SPEAK_MESSAGE, CANCEL_MESSAGE):
            await self._handle_client_message(frame)
            return

        if isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM:
            # The aggregator's "run the LLM now" frame. Speculative frames (eager end of turn)
            # are not finished turns; neither kind travels further, since nothing downstream
            # is an LLM.
            if not frame.speculation:
                await self._emit_user_turn(frame.context)
            return

        if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
            self._stop_received_replies()

        await self.push_frame(frame, direction)

    async def _emit_user_turn(self, context: LLMContext) -> None:
        text = _take_user_text(context)
        if text:
            await self.push_frame(RTVIServerMessageFrame(data={"type": USER_TURN_EVENT, "text": text}))

    def _stop_received_replies(self) -> None:
        self._streaming_seq = None
        self._closed_through_seq = max(self._closed_through_seq, self._newest_seq)
        self._interrupted_through_seq = max(self._interrupted_through_seq, self._newest_seq)

    async def _handle_client_message(self, frame: RTVIClientMessageFrame) -> None:
        seq = _read_seq(frame.data)
        if seq is None:
            logger.warning(f"{self}: dropping {frame.type} without a valid seq")
            return
        if frame.type == CANCEL_MESSAGE:
            # Only the newest reply can still be audible; cancelling an older one, or one already
            # interrupted, has nothing left to stop.
            if seq == self._newest_seq and seq > self._interrupted_through_seq:
                # A broadcast leaves from this processor and never re-enters it, so the replies
                # are closed here; the interruption clears TTS audio already queued downstream.
                self._stop_received_replies()
                await self.broadcast_interruption()
            return
        if seq <= self._closed_through_seq:
            return

        data = frame.data if isinstance(frame.data, dict) else {}
        text = data.get("text") if isinstance(data.get("text"), str) else ""
        if self._streaming_seq != seq:
            await self._finish_streaming()
            self._streaming_seq = seq
            self._newest_seq = max(self._newest_seq, seq)
            await self.push_frame(LLMFullResponseStartFrame())
        if text:
            await self.push_frame(LLMTextFrame(text))
        if data.get("final") is True:
            await self._finish_streaming()

    async def _finish_streaming(self) -> None:
        seq = self._streaming_seq
        if seq is None:
            return
        self._streaming_seq = None
        self._closed_through_seq = max(self._closed_through_seq, seq)
        await self.push_frame(LLMFullResponseEndFrame())
