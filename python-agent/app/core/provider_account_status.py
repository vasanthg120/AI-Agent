"""Dynamic, platform-wide LLM provider availability — reads what NestJS's
ProviderFinanceService/ProviderAlertService (backend/src/provider-finance/)
write to the "provider_accounts" Mongo collection, same collection, same
"platform-wide, no per-org scope" convention as app.core.langfuse_config's
own config read.

Two things live here:
  - is_exhausted(provider): a cached read app.agent.orchestrator checks
    before attempting a provider, so a known-exhausted provider is skipped
    straight to its fallback instead of wasting a real network call that's
    certain to fail the same way the last one did.
  - mark_exhausted(provider): called from app.observability.tracing's
    traced_llm_call when a call fails with a CONFIRMED provider-reported
    billing/credit-exhaustion error (never a guess, never from an estimated
    balance — see mark_exhausted's own docstring for exactly what signal
    this requires) — immediately reflected in both routing and the Provider
    Finance dashboard, not just on the next hourly alert-cron tick.

Same "module-level dict + time.monotonic() freshness check" TTL-cache
pattern langfuse_config.py already established, for the same reason: a
plain per-call Mongo read (integration_store.py's older pattern) would be a
database round-trip on every single LLM call.
"""

import logging
import threading
import time

from app.memory.mongo_client import get_db

logger = logging.getLogger(__name__)

_STATUS_TTL_SECONDS = 60
_lock = threading.Lock()
_cache: dict = {"at": 0.0, "status_by_provider": {}}


def _refresh_cache() -> dict:
    with _lock:
        if time.monotonic() - _cache["at"] < _STATUS_TTL_SECONDS:
            return _cache["status_by_provider"]

    docs = list(get_db().provider_accounts.find({}, {"provider": 1, "status": 1}))
    status_by_provider = {d["provider"]: d.get("status") for d in docs}

    with _lock:
        _cache.update(at=time.monotonic(), status_by_provider=status_by_provider)
    return status_by_provider


def is_exhausted(provider: str) -> bool:
    """Never raises — a Mongo hiccup here must never block a real LLM call;
    worst case, an exhausted provider is attempted once more and fails the
    normal way, exactly as it would have without this check at all."""
    try:
        return _refresh_cache().get(provider) == "exhausted"
    except Exception:
        logger.exception("Could not read provider account status — treating %s as available.", provider)
        return False


def mark_exhausted(provider: str) -> None:
    """Called only from a CONFIRMED provider-reported billing/credit error
    (see tracing.py's own call site for the exact, narrowly-matched
    exception types this is guarded behind) — never from an estimated
    balance crossing a configurable threshold, which is a weaker signal
    handled separately by the NestJS-side alert cron
    (ProviderAccount.zeroBalanceAction). Invalidates the cache immediately
    so the very next routing check sees it, not after the TTL expires.
    Never raises — a failure to record this is a missed optimization
    (one more wasted call before the error recurs), not a reason to break
    the request that triggered it."""
    try:
        get_db().provider_accounts.update_one({"provider": provider}, {"$set": {"status": "exhausted"}}, upsert=True)
        with _lock:
            _cache.update(at=0.0, status_by_provider={})
    except Exception:
        logger.exception("Could not mark %s as exhausted.", provider)
