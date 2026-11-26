"""Zapier as a generic connector: the actions of every app connected in the
organization's Zapier account (Hoops, Gorilla Dash, …), reached through Zapier
MCP (https://docs.zapier.com/mcp) — server-side only.

How it's wired:
- An administrator creates a Zapier MCP server at mcp.zapier.com for a custom
  client, puts it in **Managed mode** (every action they enable becomes its own
  fixed tool — a reviewed, predictable toolset), and pastes the server's
  connection token into HaiVE. The token is stored encrypted as the
  organization's "zapier" integration and never reaches the browser.
- `discover()` connects to https://mcp.zapier.com/api/v1/connect
  (Authorization: Bearer <token>, Streamable HTTP), lists the tools, works out
  which app each action belongs to and whether it reads or writes, and caches
  that catalog in Mongo (zapier_catalogs) for the UI and the AI.
- `call()` runs one catalogued action. Nothing outside the catalog can be run.
  Whether an action is a read is decided again here, at execution time
  (`action_kind`), never taken from the cached catalog. Anything not provably a
  read is refused unless the caller passes approved=True, which only the AI tool
  does, after app.memory.zapier_approvals matches a preview from an earlier turn.

Zapier bills two tasks per successful call; failures are free.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from datetime import datetime, timedelta, timezone

from app.memory import integration_store
from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

PROVIDER = "zapier"
MCP_URL = "https://mcp.zapier.com/api/v1/connect"
TIMEOUT_SECONDS = 60

# Agentic mode exposes these instead of the actions themselves.
META_TOOLS = {
    "inspect_zapier_actions",
    "discover_zapier_actions",
    "enable_zapier_action",
    "disable_zapier_action",
    "auto_provision_mcp",
    "execute_zapier_read_action",
    "execute_zapier_write_action",
    "list_zapier_connections",
    "manage_zapier_connections",
    "get_configuration_url",
    "list_zapier_skills",
    "get_zapier_skill",
    "create_zapier_skill",
    "update_zapier_skill",
    "delete_zapier_skill",
    "send_feedback",
    "write_code_action",
}

# Action classification (see kind_of). Zapier actions are whatever an
# administrator enabled, so there is no fixed list to review: "read" has to be
# shown by the action's name and title, and everything else is a write.
_READ_VERBS = {"find", "search", "get", "list", "lookup", "retrieve", "read", "fetch"}
# Change data wherever they appear: "find_or_create_contact", "get_and_delete_item".
_MUTATION_WORDS = {
    "add", "append", "approve", "archive", "assign", "cancel", "create", "creates", "delete", "destroy",
    "disable", "duplicate", "edit", "enable", "execute", "forward", "grant", "insert", "invite", "merge",
    "modify", "overwrite", "publish", "purge", "refund", "register", "reject", "remove", "rename", "reply",
    "reschedule", "revoke", "send", "submit", "subscribe", "trigger", "unarchive", "unassign",
    "unregister", "unsubscribe", "update", "upload", "upsert", "void", "wipe", "write",
}
# Also nouns ("find_record", "get_comment"), so they only count as a verb when
# they lead the action or follow "and" / "or" / "then".
_VERB_OR_NOUN = {
    "activate", "apply", "attach", "book", "build", "call", "change", "charge", "clear", "clone", "close",
    "comment", "complete", "convert", "copy", "deactivate", "deploy", "detach", "draft", "drop", "export",
    "follow", "generate", "import", "issue", "label", "like", "link", "lock", "log", "make", "mark", "move",
    "new", "notify", "open", "patch", "pause", "pay", "post", "push", "put", "record", "request", "reset",
    "restore", "resume", "run", "save", "schedule", "set", "share", "start", "stop", "sync", "tag", "text",
    "transfer", "trash", "unlink", "unlock", "vote",
}
_VERBS = (
    "find", "search", "get", "list", "lookup", "retrieve", "fetch", "create", "update", "add", "send", "delete",
    "remove", "upsert", "set", "post", "run", "start", "stop", "copy", "move", "archive",
)


class ZapierError(Exception):
    """A readable problem with the Zapier connection (safe to show a person)."""


def connection_token(organization_id: str | None) -> str | None:
    creds = integration_store.get_credentials(PROVIDER, organization_id)
    if not creds:
        return None
    values = creds.get("credentials") or {}
    if creds.get("authType") == "bearer":
        return (values.get("bearerToken") or "").removeprefix("Bearer ").strip() or None
    return (values.get("apiKey") or "").strip() or None


def _run(coro):
    """Run a coroutine from sync code, whether or not an event loop is already
    running in this thread (FastAPI handlers vs. the agent's worker threads)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    result: dict = {}

    def worker():
        try:
            result["value"] = asyncio.run(coro)
        except BaseException as exc:  # re-raised in the caller's thread
            result["error"] = exc

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(TIMEOUT_SECONDS + 5)
    if "error" in result:
        raise result["error"]
    return result.get("value")


def _friendly(exc: BaseException) -> ZapierError:
    text = str(exc)
    for inner in getattr(exc, "exceptions", []) or []:  # anyio ExceptionGroup
        text += f" {inner}"
    if re.search(r"\b401\b|unauthori[sz]ed|invalid token", text, re.I):
        return ZapierError(
            "Zapier rejected the connection token — it was revoked or has expired. Generate a new one at "
            "mcp.zapier.com and reconnect Zapier in Settings → Data Sources."
        )
    if re.search(r"\b403\b|forbidden", text, re.I):
        return ZapierError("Zapier refused access with this connection token (no permission for this action).")
    if re.search(r"timed? ?out|timeout", text, re.I):
        return ZapierError("Zapier didn't respond in time. Try again in a minute.")
    return ZapierError("Couldn't reach Zapier. Try again in a minute.")


async def _with_session(token: str, fn):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(
        MCP_URL, headers={"Authorization": f"Bearer {token}"}, timeout=timedelta(seconds=TIMEOUT_SECONDS)
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await fn(session)


def app_of(name: str, title: str | None, description: str | None) -> str:
    """Which connected app an action belongs to: the tool title's prefix
    ("Hoops: Create Customer"), else the words before the action verb in the
    tool name ("gorilla_dash_create_enquiry" -> "Gorilla Dash")."""
    if title and ":" in title:
        return title.split(":", 1)[0].strip()
    parts = [p for p in re.split(r"[_\-\s]+", name) if p]
    app_words: list[str] = []
    for part in parts:
        if part.lower() in _VERBS:
            break
        app_words.append(part)
    if app_words and len(app_words) < len(parts):
        return " ".join(w.capitalize() for w in app_words)
    match = re.search(r"\bin ([A-Z][\w .&-]{1,40}?)(?:[.,]|$)", description or "")
    return match.group(1).strip() if match else "Other"


def _words(text: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text or "")
    words: list[str] = []
    for word in (w for w in re.split(r"[^a-z0-9]+", spaced.lower()) if w):
        if word == "up" and words and words[-1] == "look":
            words[-1] = "lookup"
        else:
            words.append(word)
    return words


def _may_change_data(words: list[str]) -> bool:
    present = set(words)
    if present & _MUTATION_WORDS:
        return True
    # Raw/custom API actions can send any HTTP method, whatever they're called.
    if ("api" in present and present & {"request", "call"}) or (
        "request" in present and present & {"raw", "custom", "http", "graphql"}
    ):
        return True
    return any(
        word in ("and", "or", "then") and following in _VERB_OR_NOUN for word, following in zip(words, words[1:])
    )


def _leading_verb(words: list[str]) -> str | None:
    for index, word in enumerate(words):
        # A trailing "list"/"read" names a thing or a state, not what's done.
        if word in ("list", "read") and index and index == len(words) - 1:
            continue
        if word in _READ_VERBS or word in _MUTATION_WORDS or word in _VERB_OR_NOUN:
            return word
    return None


def kind_of(name: str, annotations: dict | None = None, title: str | None = None) -> str:
    """"read" or "write". Fails closed: an action is a read only when nothing
    about it suggests a change AND either its verb is a read verb or, with no
    known verb at all, Zapier marks it read-only. Anything unrecognised is a
    write. Zapier's hint never overrides a name or title that says it changes
    data."""
    annotations = annotations or {}
    if annotations.get("destructiveHint") is True or annotations.get("readOnlyHint") is False:
        return "write"
    app_prefix, separator, action_title = (title or "").partition(":")
    if not separator:
        app_prefix, action_title = "", title or ""
    name_words = _words(name)
    # Drop the app's own name, so e.g. "Follow Up Boss" isn't read as a verb.
    prefix = _words(app_prefix)
    if prefix and name_words[: len(prefix)] == prefix:
        name_words = name_words[len(prefix):]
    if _may_change_data(name_words) or _may_change_data(_words(action_title)):
        return "write"
    verb = _leading_verb(name_words)
    if verb in _READ_VERBS:
        return "read"
    return "read" if verb is None and annotations.get("readOnlyHint") is True else "write"


def action_kind(tool: dict) -> str:
    """The kind of a catalogued action, decided now. The cached "kind" is never
    trusted: catalogs saved by earlier versions labelled some writes "read"."""
    return kind_of(tool.get("name") or "", tool.get("annotations"), tool.get("title"))


def apps_of(tools: list[dict]) -> list[dict]:
    """Action titles per app, split into read and write."""
    apps: dict[str, dict] = {}
    for tool in tools:
        entry = apps.setdefault(tool["app"], {"app": tool["app"], "read": [], "write": []})
        entry[action_kind(tool)].append(tool["title"])
    return sorted(apps.values(), key=lambda a: a["app"].lower())


def discover(organization_id: str) -> dict:
    """Lists the actions the organization's Zapier MCP server exposes, groups
    them by app and caches the result. Errors are cached too, so the UI can say
    what's wrong (revoked token, agentic mode, …)."""
    token = connection_token(organization_id)
    if not token:
        raise ZapierError("Zapier isn't connected. Connect it in Settings → Data Sources.")
    db = get_db()
    try:
        listed = _run(_with_session(token, lambda s: s.list_tools()))
    except ZapierError:
        raise
    except Exception as exc:  # noqa: BLE001 - mapped to a readable message
        error = _friendly(exc)
        db.zapier_catalogs.update_one(
            {"organizationId": organization_id},
            {"$set": {"organizationId": organization_id, "error": str(error), "refreshedAt": datetime.now(timezone.utc)}},
            upsert=True,
        )
        raise error from exc

    tools = []
    meta = 0
    for tool in listed.tools:
        if tool.name in META_TOOLS:
            meta += 1
            continue
        annotations = tool.annotations.model_dump(exclude_none=True) if getattr(tool, "annotations", None) else {}
        title = annotations.get("title") or getattr(tool, "title", None)
        tools.append(
            {
                "name": tool.name,
                "title": title or tool.name.replace("_", " ").capitalize(),
                "description": (tool.description or "")[:500],
                "app": app_of(tool.name, title, tool.description),
                "kind": kind_of(tool.name, annotations, title),
                "annotations": {k: annotations[k] for k in ("readOnlyHint", "destructiveHint") if k in annotations},
                "inputSchema": tool.inputSchema or {"type": "object"},
            }
        )
    mode = "agentic" if meta and not tools else "managed"
    catalog = {
        "organizationId": organization_id,
        "mode": mode,
        "tools": tools,
        "apps": apps_of(tools),
        "refreshedAt": datetime.now(timezone.utc),
        "error": None,
    }
    db.zapier_catalogs.update_one({"organizationId": organization_id}, {"$set": catalog}, upsert=True)
    return catalog


def catalog_for(organization_id: str) -> dict | None:
    return get_db().zapier_catalogs.find_one({"organizationId": organization_id}, {"_id": 0})


def call(organization_id: str, tool_name: str, arguments: dict, *, approved: bool = False) -> str:
    """Runs one catalogued Zapier action and returns its result as text. This is
    the only place an action reaches Zapier: anything but a read needs
    approved=True."""
    catalog = catalog_for(organization_id) or {}
    tool = next((t for t in catalog.get("tools") or [] if t["name"] == tool_name), None)
    if not tool or tool_name in META_TOOLS:
        raise ZapierError(
            f"'{tool_name}' isn't one of the Zapier actions enabled for HaiVE. Use the 'actions' listing to see what is."
        )
    if not approved and action_kind(tool) != "read":
        raise ZapierError(f"'{tool['title']}' can change data, so it can't run without the user's approval.")
    token = connection_token(organization_id)
    if not token:
        raise ZapierError("Zapier isn't connected. Connect it in Settings → Data Sources.")
    try:
        result = _run(_with_session(token, lambda s: s.call_tool(tool_name, arguments)))
    except Exception as exc:  # noqa: BLE001
        raise _friendly(exc) from exc
    texts = [getattr(c, "text", "") for c in result.content if getattr(c, "type", "") == "text"]
    body = "\n".join(t for t in texts if t) or json.dumps([c.model_dump() for c in result.content], default=str)[:4000]
    if result.isError:
        raise ZapierError(f"Zapier couldn't run '{tool['title']}' in {tool['app']}: {body[:500]}")
    return body[:8000]
