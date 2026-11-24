# Work automation (automatic To-Do & EOD) — integration status and verification

Code: `backend/src/work-automation/`, `python-agent/app/routes/work_automation.py`,
`python-agent/app/integrations/gmail_actions.py`, `frontend/src/features/work/`.

Status words used here, strictly:

* **Implemented** — the code exists.
* **Mocked** — covered by tests whose outside world is a fake.
* **Real service** — exercised against a real MongoDB / real python-agent / real Anthropic API.
* **Production verified** — shown to work with real accounts end to end. Nothing in this system has reached this level yet.

## Sources

| Source | Status | What it reads / why not |
|---|---|---|
| Pantheras CRM (`prospectconnect`) | Implemented · Mocked · Real MongoDB (seeded data) | Deals and quotes owned by an employee (`Deal.ownerId`, `Quote.ownerUserId`, set by verified Deal Assignment mappings). Never matched by name. Not run against a live Pantheras account. |
| Hoops CRM | Implemented · Mocked · Real MongoDB (seeded data) | Same adapter, `sourceProvider: hoops`. Not run against a live Hoops account. |
| Outlook email (Email Intelligence) | Implemented · Mocked · Real MongoDB (seeded data) | Unanswered customer emails the existing AI classified as needing a company reply, and follow-up reminders. Closed only by a recorded reply. |
| Gmail | Implemented · Mocked (python logic + adapter) | `gmail.readonly` + `gmail.send` are enough for threads, labels and snippets. Automated mail is dropped by headers/labels, the rest goes through a strict AI check (nothing is proposed if the AI is down). Closed only when the employee sent a later message in the thread. **No Gmail account is connected in this environment, so it has never run against real Gmail.** Off by default (enable "gmail" under Settings → Work automation). AI classification is not billed per call yet. |
| GorillaDash | **Not possible — API limitation** | The GorillaDash API Haive uses (`/api/v1/enquiries, people, enquiry-forms, tribes, reviews, knowledge-articles, blog-articles, digest-posts, food-menu-items, media`) has no tasks, activities or follow-ups, and enquiries carry no assignee/status field. Enquiries already arrive as CRM deals. No GorillaDash connection exists in this environment, so this is from the client code and `docs/crm-data-sources.md`, not a live call. Shown on the admin page as unsupported. |
| Google Calendar | **Not possible — no access** | Haive's Google connections are Gmail (`gmail.readonly`, `gmail.send`, `userinfo.email`) and Drive. No calendar scope was ever granted. It needs a new consent (`calendar.readonly`) per employee and a new OAuth flow. Not implemented; nothing is guessed. |
| Outlook Calendar | Implemented (meetings list in each EOD) · Mocked | Reads the signed-in user's calendar via Graph (`Calendars.Read` is in the stored scopes of the two real connections). Meetings are listed as scheduled, never as "attended". Preparation tasks / meeting follow-up tasks are not created. |

## Email delivery

| Channel | Verified |
|---|---|
| SMTP (Gmail SMTP, `smtp.gmail.com:587`) | **Real service:** `transporter.verify()` connected and authenticated (no message was sent). A real send has **not** been made: it needs a test recipient you control. |
| Outlook mailbox | Stored scopes of the two real connections include `Mail.Send`; refresh tokens present; access tokens are a month expired so the refresh path would run. Not exercised: it would use a real employee's mailbox and rewrite their stored token. |
| Gmail mailbox | `gmail.send` is in the requested scopes. No Gmail connection exists here. Not exercised. |

To produce real evidence, run the gated spec with test accounts you control:

```
cd backend
LIVE_EMAIL_EMPLOYEE_TO=<test inbox> LIVE_EMAIL_MANAGER_TO=<test inbox> npx jest work-automation.live-email
# optional mailbox sending, from a TEST employee's connected mailbox:
#   LIVE_PYTHON_URL=http://127.0.0.1:8000 (a python-agent that has /work/send-mail)  LIVE_SENDER_USER_ID=... LIVE_SENDER_ORG_ID=...
```

It prints the provider response for each send and tells you which two subjects to look for.

## AI EOD

`LIVE_AI_URL=<python-agent serving /work/eod-summary> npx jest work-automation.live-ai` runs NestJS → FastAPI → Anthropic against a throwaway MongoDB and checks the summary against the records (billing stubbed for the throwaway organization).

## Dates and timezones

Date-only CRM deadlines (`expectedClosingDate`, quote `dueDate`) end at the last millisecond of that calendar day **in the organization's timezone** (`work_automation_configs.timezone`, else the organization's own). Tested in Asia/Kolkata, UTC, Australia/Sydney, America/Los_Angeles and both America/New_York daylight-saving changes.

## Zero-activity reports

Every active team member (manager, consultant, AI-role member — never the organization's owner) gets an EOD each day, plus anyone with tracked work. The report states one of four readings, never a productivity judgement:

* `no_assigned_work` — nothing is assigned in the connected platforms;
* `no_completed_work` — work is assigned, none verified complete;
* `worked` — verified completed work exists;
* `sync_unreliable` — a source failed, ran partially, or has not run in 24 h, so nothing can be concluded.

"Activity detected" (replies sent, CRM changes, meetings, the person's own task actions) is reported separately from tasks.

## EOD recipient: the organization admin

Each employee's EOD is addressed to the responsible admin of **that employee's own organization**, resolved from existing records (`work-automation/eod-recipient.resolver.ts`). No address is configured or hard-coded; `LIVE_EMAIL_*` exist only for the opt-in live test.

Resolution order (exactly one admin, never fanned out): (1) the first active `owner` up the employee's `reportingManagerId` chain, same organization; (2) `Organization.ownerUserId`; (3) the organization's active `owner`-role user (oldest login account if several). Every lookup is scoped by the employee's `organizationId`.

The recipient address is the admin's active, not-`needs_reauth` Gmail/Outlook connection (organization channel order), and the report is sent **from that admin mailbox** through python-agent (which refreshes expired tokens). With no connected mailbox, the delivery row carries `warning: admin_mailbox_not_connected` and only the SMTP fallback goes to the admin's account email. The admin is re-resolved at send time; if they changed, the row is skipped (`admin_changed`). Rows record `recipientEmail`, `recipientProvider`, `channelAttempts` (error/response per channel), `providerResponse`, `lastError`. Idempotent per (report, role) via the existing unique index. The employee and manager copies are unchanged, except a manager who is the admin is skipped (`same_as_admin`).
