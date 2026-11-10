# Enterprise AI Agent

Agentic RAG assistant with enterprise integrations (Outlook, CRM, WhatsApp, Email, Calendar).

## Architecture

```
             React (frontend)
                   │  REST / WebSocket
             NestJS (backend)  ──►  JWT auth, users, chat gateway, integrations
                   │  REST (JWT forwarded)
          FastAPI (python-agent) ──► LangGraph agent + tool-calling loop
                   │
     ┌─────────────┼───────────────┐
  MongoDB       Qdrant        OpenAI + Gemini
 (memory)   (vector store)      (LLM router)
```

- **frontend/** — Vite + React + TypeScript chat UI. Login/register, a WebSocket chat
  page, and document upload.
- **backend/** — NestJS API gateway. Owns auth (JWT), users, WebSocket chat, and the
  CRM/Outlook dashboard modules. Proxies chat and document-ingest requests to the
  Python agent, forwarding the caller's JWT.
- **python-agent/** — FastAPI + LangGraph. The "AI brain": a planner/tool-calling loop
  built on a LangGraph `StateGraph`. Two LLM providers are wired in behind a smart
  router (`app/agent/router.py`): short, simple, non-tool-shaped turns go to Gemini
  (`GEMINI_MODEL`, default `gemini-2.5-flash` — cheaper/faster), everything else
  (already mid tool-loop, long messages, or messages that look like they need
  CRM/Outlook/calendar/document/etc. data) goes to OpenAI (`OPENAI_MODEL`, default
  `gpt-5.4-mini`). If Gemini errors or is unconfigured, it falls back to OpenAI in
  the same turn — Gemini is optional; leave `GEMINI_API_KEY` blank to run
  OpenAI-only. Both providers' responses are normalized into the same
  OpenAI-Responses-API-shaped item list, so the rest of the graph (tool execution,
  reply extraction) doesn't need to know which model answered. Nine tools are
  registered:
  CRM, Outlook, calendar, WhatsApp, email (real SMTP send), employee directory,
  database (reads the shared MongoDB), document search (RAG retrieval), and web
  search. Re-validates the JWT the backend forwards — never openly callable.
- **MongoDB** — conversations (owned/written by the backend; read by the agent for
  context), users, notes.
- **Qdrant** — document chunk embeddings (`sentence-transformers/all-MiniLM-L6-v2` by
  default) for RAG retrieval.
- **Redis** — wired into compose for future async/queue work; nothing consumes it yet.

## Prerequisites

- Docker Desktop (the fastest path — everything runs via one command)
- For local (non-Docker) dev: Node.js 22 LTS, Python 3.12

> **This machine's status**: Node 24 + npm, Python 3.12, and MongoDB (native Windows
> service) are installed and working. Docker Desktop is installed but its WSL2
> backend needs the Windows "Virtual Machine Platform" feature enabled (`dism.exe
> /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`,
> `Microsoft-Windows-Subsystem-Linux` the same way) plus a restart — until then,
> Qdrant (and anything relying on `docker compose`) can't run. Everything else
> (backend, python-agent, frontend) has been installed, built, and run directly.

## Quick start (Docker)

```bash
# 1. Configure secrets
cp backend/.env.example      backend/.env
cp python-agent/.env.example python-agent/.env
# Edit both: set OPENAI_API_KEY in python-agent/.env (required),
# optionally GEMINI_API_KEY too (enables the smart router — leave blank for OpenAI-only),
# and set the SAME JWT_SECRET in both files.

# 2. Bring everything up
docker compose up --build
```

Then open:

- Frontend: http://localhost:5173
- Backend (health): http://localhost:3000/health
- Python agent (docs): http://localhost:8000/docs
- Qdrant dashboard: http://localhost:6333/dashboard

## Local dev without Docker

```bash
# backend
cd backend && cp .env.example .env && npm install && npm run start:dev

# python-agent (needs Python 3.12+ and Mongo/Qdrant reachable)
cd python-agent && cp .env.example .env
python -m venv .venv && .venv/Scripts/activate  # or source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# On Windows, if a freshly-installed Python still isn't on PATH in your current
# terminal (common — PATH updates don't reach already-open shells) or
# Activate.ps1 is blocked by execution policy, skip activation and call the
# venv's binaries directly instead:
#   & "<path-to-python.exe>" -m venv .venv
#   .\.venv\Scripts\pip.exe install -r requirements.txt
#   .\.venv\Scripts\uvicorn.exe app.main:app --reload --port 8000

# frontend
cd frontend && cp .env.example .env && npm install && npm run dev
```

## Auth flow

1. `POST /auth/register` then `POST /auth/login` on the backend → returns a JWT.
2. The frontend stores the JWT and sends it as `Authorization: Bearer <token>` (REST)
   or `auth: { token }` (Socket.IO handshake).
3. The backend validates the JWT, then **forwards it** to the Python agent, which
   re-validates it with the shared `JWT_SECRET`. The agent is never openly callable.

## Chat flow

`ChatPage` (frontend) → Socket.IO `/chat` namespace (backend `ChatGateway`) → forwards
the message + bearer token to the agent's `POST /chat` → the agent reads recent
conversation history straight out of MongoDB (the backend already persisted it),
runs the LangGraph planner/tool loop (routed to Gemini or OpenAI per turn — see
Architecture above), and returns the reply → the backend appends both turns to the
conversation document and emits the reply back over the socket.

## Document ingest / RAG flow

Frontend upload → backend `POST /documents/upload` (multipart) → forwarded to the
agent's `POST /documents/ingest` → text extracted (PDF/DOCX/Excel/CSV/HTML/plain
text) → chunked → embedded → upserted into Qdrant with `document_id`/`user_id`
metadata. The agent's `search_documents` tool queries the same collection at
answer time.

## What's stubbed vs. real

Real and wired end-to-end:

- JWT auth, user registration/login, MongoDB persistence, `GET /users/me`
- Chat: frontend → backend → python-agent → OpenAI (or Gemini, via the smart
  router) → response, with conversation history persisted and read back for context
- LangGraph agent loop with native function calling (bounded to 5 tool rounds),
  routed per-turn between OpenAI's Responses API and Gemini (`app/agent/router.py`
  picks the provider; `app/agent/gemini_client.py` normalizes Gemini's response
  into the same item shape OpenAI returns, so the rest of the loop is
  provider-agnostic). Gemini is optional — unset `GEMINI_API_KEY` runs OpenAI-only
- Full RAG pipeline: document loaders, chunking, `sentence-transformers` embeddings,
  Qdrant upsert/search, wired into a `search_documents` tool
- `send_email` (real SMTP) and `send_whatsapp_message` (real Meta Cloud API call)
  once SMTP/WhatsApp credentials are set — both no-op with a clear stub message
  until then
- `query_database` tool reads a live `notes` collection and user `preferences` —
  the collection is just empty until something writes to it (no notes UI yet)

Stubbed (structure and tool schema in place, returns placeholder data):

- `crm_tool` / backend CRM module — swap in real HTTP calls once `CRM_BASE_URL`/
  `CRM_API_KEY` point at a real CRM
- `outlook_tool` / `calendar_tool` / backend Outlook module — swap in a Microsoft
  Graph OAuth2 flow once `MS_GRAPH_CLIENT_ID/SECRET/TENANT_ID` are set
- `employee_tool` — placeholder directory, swap for a real HRIS/Azure AD lookup
- `web_search` — no default provider wired; plug in Tavily/Bing/SerpAPI via
  `SEARCH_API_KEY`

Each stub is a single Python function in `python-agent/app/tools/`.
