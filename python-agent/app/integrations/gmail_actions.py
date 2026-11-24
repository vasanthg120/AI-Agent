"""Finding genuinely actionable email in a user's Gmail, for the To-Do.

Two kinds of thread become a task candidate - never "every email":

* reply_owed        a person wrote last, it is not automated mail, and (AI check) they
                    ask for something the user is expected to answer;
* promised_followup the USER wrote last and their own message commits to doing or
                    sending something later ("I'll send the quote tomorrow").

Everything before the AI check is deterministic (labels, headers, who wrote last), so
newsletters, notifications, receipts and the user's own plain replies never reach it.
When the AI is not available nothing new is proposed (fail safe), and the caller is told
the read was not complete.

Closing is evidence-based and needs no AI: a task is resolved only when a later message
from the user exists in the same Gmail thread.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from email.utils import parseaddr

GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
MAX_THREADS = 40
MAX_CLASSIFIED = 15
_NOREPLY = re.compile(r"(^|[._-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?|alerts?|bounce[sd]?)([._-]|@|$)", re.I)


def _header(message: dict, name: str) -> str:
    for h in (message.get("payload") or {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _at(message: dict) -> datetime:
    return datetime.fromtimestamp(int(message.get("internalDate", "0")) / 1000, tz=timezone.utc)


def is_automated(message: dict) -> bool:
    """Bulk, list, auto-generated or system mail: never a person asking for a reply."""
    if _header(message, "List-Unsubscribe"):
        return True
    if _header(message, "Precedence").lower() in {"bulk", "list", "junk"}:
        return True
    auto = _header(message, "Auto-Submitted").strip().lower()
    if auto and auto != "no":
        return True
    labels = set(message.get("labelIds") or [])
    if labels & {"CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"}:
        return True
    address = parseaddr(_header(message, "From"))[1]
    return bool(_NOREPLY.search(address))


def describe_thread(thread: dict, self_email: str) -> dict | None:
    """The facts the rules need, from one Gmail thread fetched with format=metadata."""
    messages = thread.get("messages") or []
    if not messages:
        return None
    me = self_email.strip().lower()
    rows = []
    for m in sorted(messages, key=lambda x: int(x.get("internalDate", "0"))):
        from_addr = parseaddr(_header(m, "From"))[1].lower()
        from_self = "SENT" in (m.get("labelIds") or []) or (bool(me) and from_addr == me)
        rows.append({"id": m["id"], "at": _at(m), "from_self": from_self, "automated": (not from_self) and is_automated(m), "from": _header(m, "From"), "to": _header(m, "To"), "snippet": m.get("snippet", ""), "draft": "DRAFT" in (m.get("labelIds") or [])})
    rows = [r for r in rows if not r["draft"]]
    if not rows:
        return None
    last = rows[-1]
    return {
        "threadId": thread["id"],
        "subject": _header(messages[0], "Subject") or "(no subject)",
        "messages": rows,
        "last": last,
        "counterpart": parseaddr(last["to"] if last["from_self"] else last["from"])[0] or parseaddr(last["to"] if last["from_self"] else last["from"])[1],
    }


def plan(threads: list[dict], known: list[dict]) -> dict:
    """Splits described threads into: still-open known tasks, resolved known tasks, and new
    candidates that need the AI check. `known` rows: {threadId, kind, lastMessageId}."""
    by_id = {t["threadId"]: t for t in threads}
    known_by_id = {k["threadId"]: k for k in known}
    still_open, resolved, candidates = [], [], []

    for k in known:
        t = by_id.get(k["threadId"])
        if t is None:
            continue  # outside the look-back window: the caller decides what that means
        last = t["last"]
        if last["id"] == k.get("lastMessageId"):
            still_open.append({"threadId": t["threadId"], "kind": k["kind"], "messageId": last["id"], "subject": t["subject"], "counterpart": t["counterpart"], "at": last["at"].isoformat(), "reason": k.get("reason", ""), "reclassified": False})
            continue
        # Something new happened in the thread since the task was made.
        later_self = [m for m in t["messages"] if m["from_self"] and m["at"] > _parse(k.get("lastMessageAt")) and m["id"] != k.get("lastMessageId")]
        if later_self:
            m = later_self[-1]
            resolved.append({"threadId": t["threadId"], "kind": k["kind"], "messageId": m["id"], "at": m["at"].isoformat(), "how": "replied" if k["kind"] == "reply_owed" else "followup_sent"})
        else:
            # A new inbound message: treat as a fresh candidate (the old task closes only via evidence).
            candidates.append(_candidate(t))

    for t in threads:
        if t["threadId"] in known_by_id:
            continue
        c = _candidate(t)
        if c:
            candidates.append(c)
    return {"still_open": still_open, "resolved": resolved, "candidates": [c for c in candidates if c]}


def _parse(value: str | None) -> datetime:
    if not value:
        return datetime.fromtimestamp(0, tz=timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _candidate(t: dict) -> dict | None:
    last = t["last"]
    if last["from_self"]:
        # The user's own message is last: only interesting if it might promise something.
        return {"threadId": t["threadId"], "kind": "promised_followup", "messageId": last["id"], "subject": t["subject"], "counterpart": t["counterpart"], "at": last["at"].isoformat(), "snippet": last["snippet"]}
    if last["automated"]:
        return None
    return {"threadId": t["threadId"], "kind": "reply_owed", "messageId": last["id"], "subject": t["subject"], "counterpart": t["counterpart"], "at": last["at"].isoformat(), "snippet": last["snippet"]}


CLASSIFY_SYSTEM_PROMPT = """You decide which email threads genuinely need action from the mailbox owner. You see only a subject, a short snippet and the sender, so be strict: when unsure, answer false.

kind "reply_owed": the OTHER person wrote last. true only when they ask a question, make a request, need a decision, a quote, a document or a date from the owner, and clearly expect a reply. false for thanks, acknowledgements, FYIs, receipts, confirmations, newsletters, notifications, out-of-office or any message that closes the conversation.

kind "promised_followup": the OWNER wrote last. true only when their own message explicitly commits to doing or sending something later (e.g. "I will send the quote tomorrow", "will get back to you by Friday", "let me check and revert"). false for ordinary replies, answers that complete the matter, thanks and sign-offs.

Return a result for every thread. Give a short reason quoting the evidence. due_hint is the deadline the text itself states, or an empty string. Never invent facts."""

CLASSIFY_TOOL = {
    "name": "classify_threads",
    "description": "Whether each thread needs action from the mailbox owner.",
    "input_schema": {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"threadId": {"type": "string"}, "actionable": {"type": "boolean"}, "reason": {"type": "string"}, "due_hint": {"type": "string"}},
                    "required": ["threadId", "actionable", "reason"],
                },
            }
        },
        "required": ["results"],
    },
}


def classify(candidates: list[dict], *, call_model) -> dict[str, dict]:
    """thread id -> {actionable, reason, due_hint}. `call_model(system, tool, user_text)` returns the tool input
    dict; any failure propagates so the caller can mark the read incomplete rather than guess."""
    if not candidates:
        return {}
    payload = [{"threadId": c["threadId"], "kind": c["kind"], "subject": c["subject"], "from_or_to": c["counterpart"], "snippet": c["snippet"][:300]} for c in candidates]
    import json

    out = call_model(CLASSIFY_SYSTEM_PROMPT, CLASSIFY_TOOL, json.dumps(payload))
    wanted = {c["threadId"] for c in candidates}
    return {r["threadId"]: r for r in out.get("results", []) if r.get("threadId") in wanted}


def run(access_token: str, *, lookback_days: int, known: list[dict], gmail_get, call_model) -> dict:
    """The whole read for one mailbox. `gmail_get(path, token, params)` and `call_model` are injected (tests, caching)."""
    profile = gmail_get("/profile", access_token, None)
    me = profile.get("emailAddress", "")
    listing = gmail_get(
        "/threads",
        access_token,
        {"maxResults": MAX_THREADS, "q": f"newer_than:{int(lookback_days)}d -category:promotions -category:social -category:updates -category:forums -in:spam -in:trash"},
    )
    refs = listing.get("threads", [])
    truncated = len(refs) >= MAX_THREADS
    described = []
    for ref in refs[:MAX_THREADS]:
        thread = gmail_get(f"/threads/{ref['id']}", access_token, {"format": "metadata", "metadataHeaders": ["From", "To", "Subject", "List-Unsubscribe", "Precedence", "Auto-Submitted"]})
        d = describe_thread(thread, me)
        if d:
            described.append(d)

    split = plan(described, known)
    candidates = split["candidates"][:MAX_CLASSIFIED]
    if len(split["candidates"]) > MAX_CLASSIFIED:
        truncated = True
    classifier = "ok"
    verdicts: dict[str, dict] = {}
    try:
        verdicts = classify(candidates, call_model=call_model)
    except Exception:  # noqa: BLE001 - fail safe: propose nothing new rather than guess
        classifier = "unavailable"

    opened = list(split["still_open"])
    for c in candidates:
        v = verdicts.get(c["threadId"])
        if v and v.get("actionable"):
            opened.append({**{k: c[k] for k in ("threadId", "kind", "messageId", "subject", "counterpart", "at")}, "reason": v.get("reason", ""), "dueHint": v.get("due_hint", ""), "reclassified": True})
    return {
        "connected": True,
        "mailbox": me,
        "open": opened,
        "resolved": split["resolved"],
        "classifier": classifier,
        # Only a full read with a working classifier may be used by the caller to retire tasks that are absent.
        "complete": classifier == "ok" and not truncated,
        "scanned": len(described),
    }
