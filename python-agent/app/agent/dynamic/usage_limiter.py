"""Request-wide model-call and tool-call counters for one dynamic-agent tree.

A call is reserved BEFORE it is made, with the check and the increment under
one lock, so parallel sub-agents can't all pass the same check. Each counter
takes only its own lock and calls nothing while holding it, so it can't
deadlock.

What is counted: each delegation planning call, each planner round of each
sub-agent (including retries and failed attempts) and each tool call a
sub-agent requests.

What is not: continuations and transport retries inside one
app.agent.anthropic_client.call, and the orchestrator's own classify,
synthesis, reflection (including its corrective round) and suggestion calls.
"""

import threading
import time


class BudgetExhaustedError(RuntimeError):
    """A sub-agent needed a model call the request no longer has."""


class DeadlineExceededError(RuntimeError):
    """A sub-agent needed another model call after the request's deadline."""


class RunningTotal:
    """A shared count with a ceiling."""

    def __init__(self, ceiling: int):
        self.ceiling = ceiling
        self.total = 0
        self._lock = threading.Lock()

    def try_reserve(self) -> bool:
        with self._lock:
            if self.total >= self.ceiling:
                return False
            self.total += 1
            return True

    def exceeded(self) -> bool:
        """True once nothing is left to reserve."""
        with self._lock:
            return self.total >= self.ceiling


class UsageLimiter:
    """What app.agent.graph's nodes consult (state["usage_limiter"])."""

    def __init__(
        self, model_calls: RunningTotal | None, tool_calls: RunningTotal | None, deadline: float | None = None
    ):
        self._model_calls = model_calls
        self._tool_calls = tool_calls
        self._deadline = deadline  # a time.monotonic() value

    def _past_deadline(self) -> bool:
        return self._deadline is not None and time.monotonic() > self._deadline

    def reserve_model_call(self) -> None:
        if self._past_deadline():
            raise DeadlineExceededError("request-wide execution deadline reached")
        if self._model_calls is not None and not self._model_calls.try_reserve():
            raise BudgetExhaustedError("request-wide model-call budget exhausted")

    def try_reserve_tool_call(self) -> bool:
        if self._past_deadline():
            return False
        return self._tool_calls is None or self._tool_calls.try_reserve()
