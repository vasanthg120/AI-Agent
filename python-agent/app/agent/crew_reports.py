"""CrewAI-based generation for the scheduled morning/EOD report only.

Deliberately scoped: the live interactive chat loop (app/agent/graph.py,
app/agent/anthropic_client.py::call) is untouched. This module exists
because the scheduled report benefits from specialized research ->
prioritize -> write passes in a way a single chat turn doesn't, and because
the blast radius of a new, heavier dependency (crewai - see requirements.txt
for why it's pinned to 0.130.0) is easiest to reason about when it's opt-in
for one workflow rather than load-bearing for every chat message.

Research is fetched with a direct execute_tool() call BEFORE the crew runs,
rather than handing agents live tools to invoke mid-loop. Verified during
integration: crewai 0.130.0's default agent executor drives tool calls
through its own text ("ReAct") loop, which appends the tool result as an
assistant-authored message and expects the model to continue from it
(a prefill technique) - and the configured Anthropic model rejects
assistant-message prefill outright ("This model does not support assistant
message prefill"), so any crew agent given a tool fails on first use. Doing
the CRM/Outlook lookup as a plain Python call sidesteps that broken path
entirely while fetching the same context the old single-agent flow did.
"""

import requests

from app.agent.anthropic_client import _resolve_api_key
from app.agent.personas import STORE_MANAGER_PROMPT
from app.config import settings
from app.memory import outlook_store
from app.observability.tracing import traced_llm_call
from app.service_token import mint_service_token
from app.tools import business_search_tool, calendar_tool
from app.tools.registry import execute_tool
from crewai import Agent, Crew, LLM, Process, Task

_ACTIVITY_TIMEOUT_SECONDS = 10

REPORT_PROMPTS = {
    "morning": (
        "today's to-do list: analyze CRM and Outlook, identify new enquiries and any "
        "that haven't received a follow-up, and list concrete priorities for today."
    ),
    "eod": (
        "an end-of-day report: summarize what was completed today, outstanding "
        "follow-ups, and anything that needs attention tomorrow."
    ),
}


def _fetch_research_context(report_type: str, organization_id: str | None) -> str:
    # user_id="*" matches how CRM/Outlook records (shared, no single owner)
    # are already tagged in the vector store (see business_search_tool.py).
    # organization_id is forwarded (previously omitted) so the org-scoped
    # filter branch in business_search_tool.py actually activates for this
    # scheduled path, matching the live chat path's own scoping — without
    # it, CRM/Outlook retrieval here fell back to an org-unaware match.
    query = f"Generate {REPORT_PROMPTS[report_type]}"
    context = {
        "user_id": "*",
        "conversation_id": "scheduled-report",
        "organization_id": organization_id,
        # Only this scheduled path opts into record ids appearing in the
        # returned text (see business_search_tool.py) — live chat never sets
        # this, so its own output is unaffected. Lets the writer optionally
        # preserve a deal/quote id in its prose, which the later
        # extract_report_structure pass can then attach to a task.
        "include_record_ids": True,
    }
    return execute_tool("search_business_context", {"query": query}, context)


def _fetch_meetings_context(user_ids: list[str]) -> str:
    """Best-effort calendar snapshot — reuses the existing calendar_tool.py
    (live Outlook Calendar via MS Graph) exactly as the interactive chat path
    already does, never a second calendar integration. Silently skips any
    user with no connected Outlook token (calendar_tool.py's own convention).

    Unlike the CRM/Outlook-email research above, this is fed to the crew as
    a distinctly-labeled section with its own evidence bar (see the
    prioritizer's task description below): a meeting existing is NOT itself
    grounds for a task — only genuine preparation needs or an explicit,
    stated follow-up are. This keeps every calendar entry from turning into
    a meaningless "attend meeting X" task."""
    lines: list[str] = []
    for user_id in user_ids:
        # The whole per-user attempt is guarded, not just the calendar call —
        # get_valid_access_token() itself can raise (e.g. a token-refresh
        # request failing for a reason other than a revoked grant, which is
        # the only case it handles internally) and this section must never
        # take the scheduled report down over one user's stale connection.
        try:
            if not outlook_store.get_valid_access_token(user_id):
                continue
            events = calendar_tool.run({"action": "list_events"}, {"user_id": user_id})
        except Exception:
            continue
        if events and "No upcoming events found." not in events:
            lines.append(f"- {events}")
    if not lines:
        return ""
    return "\n\nUpcoming Outlook calendar events for staff at this store:\n" + "\n".join(lines)


def _fetch_recent_activity_context(user_ids: list[str], organization_id: str | None) -> str:
    """Real, timestamp-grounded "what actually happened today" per staff
    member — GET /tasks/eod (backend/src/dashboard/tasks.service.ts's
    getEodSummary, real DB aggregates, never LLM-narrated), called once per
    roster user with a per-user service token (same mint_service_token
    bridge app.billing.client already uses). Deliberately separate from
    _fetch_research_context above: that's a semantic (vector) search over
    all-time synced CRM/Outlook data, with no recency awareness at all — an
    enquiry from weeks ago can score as highly as one from an hour ago. This
    gives the prioritizer/writer a small, real, today-only count per person
    to weigh alongside that broader semantic context, without touching the
    shared search tool (business_search_tool.py) live chat also depends on.
    Best-effort per user, same as _fetch_meetings_context: one user's
    failure never takes the whole report down."""
    if not organization_id:
        return ""
    lines: list[str] = []
    for user_id in user_ids:
        try:
            token = mint_service_token(user_id, organization_id)
            response = requests.get(
                f"{settings.backend_url}/tasks/eod",
                headers={"Authorization": f"Bearer {token}"},
                timeout=_ACTIVITY_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            data = response.json()
        except Exception:
            continue
        email = data.get("email", {})
        crm = data.get("crm", {})
        parts = [
            f"{email.get('received', 0)} email(s) received",
            f"{email.get('responded', 0)} responded",
            f"{crm.get('dealsCreated', 0)} deal(s) created",
            f"{crm.get('dealsUpdated', 0)} deal(s) updated",
            f"{crm.get('quotesCreated', 0)} quote(s) created",
            f"{crm.get('quotesUpdated', 0)} quote(s) updated",
        ]
        lines.append(f"- User {user_id}: " + ", ".join(parts))
    if not lines:
        return ""
    return "\n\nReal activity counts for today so far (from the app's own records, not search):\n" + "\n".join(lines)


def _make_llm() -> LLM:
    api_key = _resolve_api_key()
    if not api_key:
        raise RuntimeError("No Anthropic API key configured")
    return LLM(model=f"anthropic/{settings.anthropic_model}", api_key=api_key)


def run_report_crew(
    report_type: str,
    *,
    organization_id: str | None = None,
    user_id: str = "",
    request_id: str = "",
    user_ids: list[str] | None = None,
) -> str:
    """Runs the prioritize -> write crew synchronously (mirrors the existing
    synchronous /chat route - no new async pattern needed) over pre-fetched
    CRM/Outlook context and returns the final prose report. Callers structure
    that prose into tasks the same way the plain chat path already does, via
    anthropic_client.extract_report_structure().

    organization_id/user_id/request_id (added alongside real billing
    enforcement for Scheduled Reports) let this write a real agent_executions
    row for backend/src/billing/reservation.service.ts's settle() to find.
    CrewAI's own LLM wrapper makes the actual Anthropic calls internally
    (bypassing anthropic_client.py's traced_llm_call entirely), so real usage
    is captured differently here: crew.kickoff()'s CrewOutput.token_usage
    aggregates prompt/completion tokens across both agents' calls, which is
    exactly as accurate as this feature can honestly report (per-agent
    attribution isn't exposed by this CrewAI version) and is billed as one
    combined "scheduled_report" execution rather than two separate ones.

    user_ids (the full store roster, optional/best-effort) is used to pull
    each connected user's Outlook calendar and each user's real today-only
    activity counts (see _fetch_meetings_context/_fetch_recent_activity_context)
    as extra context — never passed to search_business_context, and never
    required (defaults to no calendar/activity section at all, matching
    pre-existing behavior)."""
    if report_type not in REPORT_PROMPTS:
        raise ValueError(f"Unknown report_type: {report_type}")

    research_context = _fetch_research_context(report_type, organization_id)
    research_context += _fetch_meetings_context(user_ids or [])
    research_context += _fetch_recent_activity_context(user_ids or [], organization_id)
    llm = _make_llm()

    prioritizer = Agent(
        role="Operations Prioritizer",
        goal="Turn raw CRM/Outlook research into a ranked list of what matters most today.",
        backstory=(
            "You triage findings into urgent/high/medium/low priorities, flagging anything "
            "overdue, so nothing important gets buried."
        ),
        llm=llm,
        verbose=False,
    )
    writer = Agent(
        role="Store Manager",
        goal="Write the final report in the Store Manager's voice.",
        backstory=STORE_MANAGER_PROMPT,
        llm=llm,
        verbose=False,
    )

    prioritize_task = Task(
        description=(
            f"Generate {REPORT_PROMPTS[report_type]}\n\n"
            f"Here is the raw research pulled from CRM and Outlook:\n\n{research_context}\n\n"
            "Rank it into urgent/high/medium/low priorities, flagging anything overdue. "
            "Some research lines are tagged with an id (e.g. 'crm_deal, id=...'/'crm_quote, id=...'/"
            "'outlook_email, id=...') — when an action item clearly comes from one of those specific "
            "records, keep that id next to it so it isn't lost; never invent one for items that don't "
            "have one.\n\n"
            "Calendar events (if any appear above) are a SEPARATE, higher evidence bar: do not create "
            "an action item just because a meeting exists. Only include one when there's a concrete, "
            "stated reason — e.g. it's an external customer meeting today that plainly needs "
            "preparation, or the research/summary elsewhere already says a follow-up from a past "
            "meeting is outstanding. A routine internal sync or a meeting with no other supporting "
            "context is not itself an action item."
        ),
        expected_output="A prioritized bullet list of concrete action items with priority labels, preserving any deal/quote/email ids the research provided, and free of meeting-existence-only items.",
        agent=prioritizer,
    )
    write_task = Task(
        description=(
            "Write the final report for the store team in a concise, direct tone - lead with the "
            "most important items, use short bullet points, no more than a few sentences of framing. "
            "Keep any deal/quote/email id the prioritized list attached to an item exactly as given."
        ),
        expected_output="The final prose report ready to send to the store team.",
        agent=writer,
        context=[prioritize_task],
    )

    crew = Crew(
        agents=[prioritizer, writer],
        tasks=[prioritize_task, write_task],
        process=Process.sequential,
        verbose=False,
    )
    with traced_llm_call(
        "scheduled_report",
        organization_id=organization_id,
        user_id=user_id,
        provider="anthropic",
        model=settings.anthropic_model,
        request_id=request_id,
    ) as usage:
        result = crew.kickoff()
        token_usage = getattr(result, "token_usage", None)
        if token_usage is not None:
            usage["input_tokens"] = getattr(token_usage, "prompt_tokens", 0) or 0
            usage["output_tokens"] = getattr(token_usage, "completion_tokens", 0) or 0
    return str(result)
