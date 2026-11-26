# Dynamic delegation: Phase 2.7 hardening

The feature stays off unless `DYNAMIC_AGENTS_ENABLED` is set **and** the organization has opted in.

## Rules for a sub-agent

| Topic | Rule |
|---|---|
| Agent budget | Each sub-agent takes one slot, when it is created. The root takes one only if it runs directly. |
| Tools | Root: the selected agent's tools that the policy permits. Child: what its parent assigned, limited to the parent's own set. An empty list means no tools. |
| Context | Sub-agents get the selected agent's instructions, memories and attached context, its model tier and the conversation history. |
| Tool policy | Every tool is classified in `python-agent/app/agent/dynamic/tool_policy.py`; an unclassified tool is refused. `remember` is blocked. Zapier only previews. |
| Reflection | The corrective round after delegation follows the same tool scope and policy. |
| Retries | Only failures `retry_policy.py` recognises as transient. At most `MAX_RETRIES`, with 2s, 4s, 8s (max 10s) backoff. Cancellation and deadline are checked before and after each wait. |
| Streaming | Contract in `stream_events.py`. NestJS emits `agentActivity` for creation, progress and validation; other events keep their existing socket names. |

## Execution limits

| Limit | Strength |
|---|---|
| Depth, agents per request | Hard |
| Model calls, tool calls | Hard for the calls counted: delegation planning, sub-agent planner rounds (including retries) and sub-agent tool calls. Reserved before each call. |
| Retries | Hard, per agent |
| Tokens, cost | **Soft.** Checked from recorded usage before an agent starts. Agents already running can pass them, with no fixed bound in tokens or dollars. A failed usage lookup counts as zero. |
| Execution time | **Soft.** No new sub-agent model or tool call starts after the deadline (Phase 2.8); the agent fails as `timed_out`. A call already in flight is not interrupted. |

Not counted by the model/tool limits: continuations and transport retries inside one Anthropic call, and the
orchestrator's classify, synthesis, reflection (including its corrective round) and suggestion calls.

Recommendation before relying on tokens or cost as a hard ceiling: reserve a worst-case token amount per call
before making it, and reconcile when it returns.

## Billing follow-ups (separate issues, not changed in this phase)

Billing is still one reservation per request, one settlement over all of the request's usage rows, and no
per-sub-agent charge. These three risks are in the shared billing and chat code and affect normal chat too:

1. **Debit can exceed the hold.** `WalletService.settleUsage` debits the full actual cost with no balance
   floor, so a request costing more than its reservation can take a wallet negative.
2. **Failed requests are not charged.** The chat route calls `release()` when the run raises, even if model
   calls were already made and paid for.
3. **Cancelled streams record zero tokens.** `anthropic_client.call` stores 0 input and output tokens for a
   cancelled stream, so that spend is not billed or counted against token and cost limits.

## Other follow-ups found while hardening (existing behaviour, not changed)

1. **Zapier read/write labels (fixed).** Actions are now classified again at execution time, unrecognised ones
   count as writes, and a write needs a preview from an earlier chat turn (`app/memory/zapier_approvals.py`).
   The server cannot tell whether the user's reply was a yes; the model still judges that.
2. **Fallback after a dynamic failure.** If the dynamic path raises (including during synthesis), the request
   falls back to the fixed specialists or the single loop. Work can repeat, already-streamed text can appear
   twice. Specialists use their own tool lists (some include `send_email` and `send_whatsapp_message`); since
   Phase 2.8 a role with a tool limit narrows them to that limit.
3. **Model-written text in existing stream events.** The request classifier's `reasoning` text and
   reflection's `reflecting` reason are still sent to the browser (the UI shows only a fixed label).
4. **Raw error text.** The chat route's `error` frame carries `str(exc)`.
5. **Cancel ownership (fixed in Phase 2.8).** `/chat/stream/cancel` only cancels the signed-in user's own turns
   in their own organization.
6. **Plans larger than the agent budget.** Sub-tasks beyond the remaining slots are dropped without a marker
   when at least one sub-task fits.
7. **Planner context.** The delegation planner sees the task and the permitted tool names, not the selected
   agent's instructions.
8. **`agentDone` is not displayed.** The frontend has never listened for it.

## Streaming contract tests

The chain is: Python engine output (`python-agent/tests/fixtures/dynamic_stream_contract.json`), then the
NestJS service and gateway, then the socket events (`frontend/src/test/chatSocketContract.json`), then the
frontend. After an intentional change, run the Python contract test and then `chat-streaming.spec.ts` with
`UPDATE_STREAM_CONTRACT=1`, and re-run all three suites.
