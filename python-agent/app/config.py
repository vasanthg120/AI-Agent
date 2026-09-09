import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    jwt_secret: str = os.environ["JWT_SECRET"]
    # Must match backend/.env's ENCRYPTION_KEY exactly (see
    # backend/src/common/encryption/encryption.service.ts) — falls back to
    # jwt_secret when unset, same fallback the Node side uses, so the two
    # stay compatible even if only one side sets this explicitly.
    encryption_key: str = os.environ.get("ENCRYPTION_KEY", "")

    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    anthropic_model: str = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    # Cheaper/faster model for routing decisions (classify_request, critique_response) —
    # both are one-shot forced-tool-choice judgments, not final-answer generation, so they
    # don't need the full model. Defaults to anthropic_model (no behavior change) until a
    # Haiku-tier model id your API key has access to is set here.
    anthropic_routing_model: str = os.environ.get("ANTHROPIC_ROUTING_MODEL", anthropic_model)

    # Fast path for tool-free general-knowledge/coding/casual requests
    # (see app.agent.groq_client) — empty string disables it, falling back
    # to the Anthropic-only path unchanged.
    groq_api_key: str = os.environ.get("GROQ_API_KEY", "")
    groq_model: str = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

    mongo_uri: str = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
    # Only used by app.notifications.client to push proactive notifications
    # (see app.workflows.definitions) — every other backend<->agent call goes
    # the other direction (NestJS calls python-agent), this is the one
    # exception, needed because only the backend owns the Socket.IO
    # connection the frontend listens on.
    backend_url: str = os.environ.get("BACKEND_URL", "http://localhost:3000")
    qdrant_url: str = os.environ.get("QDRANT_URL", "http://localhost:6333")
    qdrant_api_key: str = os.environ.get("QDRANT_API_KEY", "")
    qdrant_collection: str = os.environ.get("QDRANT_COLLECTION", "documents")
    redis_url: str = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

    embedding_model: str = os.environ.get(
        "EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
    )

    rag_sync_interval_minutes: int = int(os.environ.get("RAG_SYNC_INTERVAL_MINUTES", "20"))
    rag_sync_max_pages: int = int(os.environ.get("RAG_SYNC_MAX_PAGES", "40"))

    # Mirrors connected external-CRM deals into the native crm_deals
    # collection so Owner/Manager/Consultant dashboards show real numbers
    # (see app.integrations.crm_mongo_sync) — shorter interval than the RAG
    # sync since dashboards poll every 60s and this is what backs their numbers.
    crm_mongo_sync_interval_minutes: int = int(os.environ.get("CRM_MONGO_SYNC_INTERVAL_MINUTES", "10"))

    crm_cache_ttl_seconds: int = int(os.environ.get("CRM_CACHE_TTL_SECONDS", "90"))
    outlook_cache_ttl_seconds: int = int(os.environ.get("OUTLOOK_CACHE_TTL_SECONDS", "45"))

    crm_base_url: str = os.environ.get("CRM_BASE_URL", "")
    crm_api_key: str = os.environ.get("CRM_API_KEY", "")

    ms_graph_client_id: str = os.environ.get("MS_GRAPH_CLIENT_ID", "")
    ms_graph_client_secret: str = os.environ.get("MS_GRAPH_CLIENT_SECRET", "")

    google_client_id: str = os.environ.get("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = os.environ.get("GOOGLE_CLIENT_SECRET", "")

    whatsapp_phone_number_id: str = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "")
    whatsapp_access_token: str = os.environ.get("WHATSAPP_ACCESS_TOKEN", "")

    smtp_host: str = os.environ.get("SMTP_HOST", "")
    smtp_port: int = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user: str = os.environ.get("SMTP_USER", "")
    smtp_password: str = os.environ.get("SMTP_PASSWORD", "")

    search_api_key: str = os.environ.get("SEARCH_API_KEY", "")

    # Voice (Sarvam AI STT/TTS) — see app/integrations/sarvam_client.py.
    # Never sent to the frontend; NestJS's voice module only ever forwards
    # raw audio bytes/JSON through to this service, it never sees this key.
    sarvam_api_key: str = os.environ.get("SARVAM_API_KEY", "")
    # Defaults match Sarvam's own current REST API defaults (verified against
    # docs.sarvam.ai as of this writing) — saaras:v3 for STT, bulbul:v3 for TTS.
    sarvam_stt_model: str = os.environ.get("SARVAM_STT_MODEL", "saaras:v3")
    sarvam_tts_model: str = os.environ.get("SARVAM_TTS_MODEL", "bulbul:v3")

    # --- Response-completeness / truncation controls ---
    # Was a hardcoded 1024 in anthropic_client.call() — the main planner/
    # chat-reply function, used for every ordinary turn. 1024 tokens
    # (~700-800 words) is small for an end-of-day report or multi-part CRM
    # analysis; raised default plus automatic bounded continuation (below)
    # directly addresses replies stopping mid-sentence. Configurable so a
    # deployment can tune cost vs. completeness without a code change.
    anthropic_max_output_tokens: int = int(os.environ.get("ANTHROPIC_MAX_OUTPUT_TOKENS", "4096"))
    # How many extra "continue where you left off" calls call() may make
    # when Claude's stop_reason is "max_tokens" (see anthropic_client.py).
    # 0 disables continuation entirely, restoring the exact old behavior of
    # returning whatever fit in one call.
    anthropic_max_continuations: int = int(os.environ.get("ANTHROPIC_MAX_CONTINUATIONS", "2"))

    # Was a hardcoded module constant (5) in graph.py — how many tool-calling
    # rounds one turn may make before the planner is forced to answer with
    # whatever it has. Raised modestly: each extra round only ever *permits*
    # more thorough multi-step lookups (e.g. paging through more CRM
    # records); it never forces more rounds for turns that already finish
    # in fewer.
    max_tool_rounds: int = int(os.environ.get("MAX_TOOL_ROUNDS", "8"))

    # Was a hardcoded default (limit=20) in conversation_store.get_recent_messages.
    # Same default kept — raising this grows every prompt's size regardless
    # of whether a given conversation needs the extra history, so it's made
    # configurable rather than changed, unlike the two above.
    conversation_history_limit: int = int(os.environ.get("CONVERSATION_HISTORY_LIMIT", "20"))

    # Were hardcoded function-default parameters in rag/hybrid_search.py.
    # Same defaults kept for the same reason as conversation_history_limit —
    # this governs prompt size, not just completeness.
    rag_top_k: int = int(os.environ.get("RAG_TOP_K", "5"))
    rag_candidate_pool_size: int = int(os.environ.get("RAG_CANDIDATE_POOL_SIZE", "20"))


settings = Settings()
