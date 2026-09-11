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

from app.agent.anthropic_client import _resolve_api_key
from app.agent.personas import STORE_MANAGER_PROMPT
from app.config import settings
from app.observability.tracing import traced_llm_call
from app.tools import business_search_tool
from app.tools.registry import execute_tool
from crewai import Agent, Crew, LLM, Process, Task

# No real user is driving this - it's a scheduled job gathering business-wide
# context. user_id="*" matches how CRM records (shared, no owner) are
# already tagged in the vector store (see business_search_tool.py).
_REPORT_CONTEXT = {"user_id": "*", "conversation_id": "scheduled-report"}

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


def _fetch_research_context(report_type: str) -> str:
    query = f"Generate {REPORT_PROMPTS[report_type]}"
    return execute_tool("search_business_context", {"query": query}, _REPORT_CONTEXT)


def _make_llm() -> LLM:
    api_key = _resolve_api_key()
    if not api_key:
        raise RuntimeError("No Anthropic API key configured")
    return LLM(model=f"anthropic/{settings.anthropic_model}", api_key=api_key)


def run_report_crew(
    report_type: str, *, organization_id: str | None = None, user_id: str = "", request_id: str = ""
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
    combined "scheduled_report" execution rather than two separate ones."""
    if report_type not in REPORT_PROMPTS:
        raise ValueError(f"Unknown report_type: {report_type}")

    research_context = _fetch_research_context(report_type)
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
            "Rank it into urgent/high/medium/low priorities, flagging anything overdue."
        ),
        expected_output="A prioritized bullet list of concrete action items with priority labels.",
        agent=prioritizer,
    )
    write_task = Task(
        description=(
            "Write the final report for the store team in a concise, direct tone - lead with the "
            "most important items, use short bullet points, no more than a few sentences of framing."
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
