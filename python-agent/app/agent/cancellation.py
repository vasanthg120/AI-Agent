"""In-memory per-conversation cancellation registry for streaming chat turns
(see app.routes.chat's /chat/stream and the new /chat/stream/cancel).
Deliberately in-process, like app.events.bus — a threading.Event set by a
cancel request, checked inside the streaming loop
(app.agent.anthropic_client.call) and between planner rounds
(app.agent.graph.should_continue). Cancelling stops further generation but
keeps whatever text was produced so far — a user who clicks "stop" wants
the partial answer kept, not thrown away.

Each running turn is registered with its owner, and only that user, in that
organization, can cancel it: a conversation id alone proves nothing. One
conversation can have several turns running, so each is tracked separately.
"""

import threading

_events: dict[str, dict[threading.Event, tuple[str, str | None]]] = {}
_lock = threading.Lock()


def start(conversation_id: str, user_id: str, organization_id: str | None) -> threading.Event:
    event = threading.Event()
    with _lock:
        _events.setdefault(conversation_id, {})[event] = (user_id, organization_id)
    return event


def request_cancel(conversation_id: str, user_id: str, organization_id: str | None) -> bool:
    """False both when nothing is running and when the caller owns none of it,
    so the answer doesn't reveal other users' activity."""
    owner = (user_id, organization_id)
    with _lock:
        owned = [event for event, who in _events.get(conversation_id, {}).items() if who == owner]
    for event in owned:
        event.set()
    return bool(owned)


def finish(conversation_id: str, event: threading.Event) -> None:
    """Removes this turn only, never another one running on the conversation."""
    with _lock:
        turns = _events.get(conversation_id)
        if turns is None:
            return
        turns.pop(event, None)
        if not turns:
            del _events[conversation_id]
