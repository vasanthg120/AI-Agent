"""Decides whether a failed dynamic sub-agent attempt is worth repeating.

Only failures recognised as transient are retried. Everything else, including
any exception type not listed here, is permanent: repeating a bad request, an
auth failure, a permission refusal or a deterministic validation error only
spends more tokens to fail the same way.

A blocked write action never reaches this module: app.tools.registry returns a
refusal string to the model rather than raising.

Note that app.agent.anthropic_client.call (and the Anthropic SDK under it)
already retries some transient errors inside a single attempt. This is the
outer, bounded retry of a whole sub-agent. Repeating one is safe because
app.agent.dynamic.tool_policy lets a sub-agent only read or preview.
"""

import json
from typing import NamedTuple

import anthropic
import httpx
import pymongo.errors
import redis.exceptions
import requests

from app.agent.dynamic.usage_limiter import BudgetExhaustedError, DeadlineExceededError

# 529 is Anthropic's "overloaded". 501/505 and other 5xx are not transient.
_TRANSIENT_STATUS = {408: "timeout", 429: "rate_limit", 500: "provider_5xx", 502: "provider_5xx",
                     503: "provider_5xx", 504: "provider_5xx", 529: "provider_5xx"}
# An error can arrive mid-stream on a 200 response, with only its type to go on.
_TRANSIENT_ERROR_TYPES = {"overloaded_error": "provider_5xx", "rate_limit_error": "rate_limit", "api_error": "provider_5xx"}
_PERMANENT_STATUS = {400: "invalid_request", 401: "authentication", 403: "permission_denied",
                     404: "not_found", 413: "invalid_request", 422: "invalid_request"}


class StructuredOutputError(ValueError):
    """The sub-agent's reply didn't satisfy its required output schema (or the
    schema itself is unusable)."""


class RetryDecision(NamedTuple):
    retryable: bool
    category: str


def _transient(category: str) -> RetryDecision:
    return RetryDecision(True, category)


def _permanent(category: str) -> RetryDecision:
    return RetryDecision(False, category)


def _from_status(status: int | None, body: object = None) -> RetryDecision:
    if status in _TRANSIENT_STATUS:
        return _transient(_TRANSIENT_STATUS[status])
    if status in _PERMANENT_STATUS:
        return _permanent(_PERMANENT_STATUS[status])
    error = body.get("error") if isinstance(body, dict) else None
    error_type = error.get("type") if isinstance(error, dict) else None
    if error_type in _TRANSIENT_ERROR_TYPES:
        return _transient(_TRANSIENT_ERROR_TYPES[error_type])
    return _permanent("provider_error")


def classify(exc: BaseException) -> RetryDecision:
    # Order matters: several of these are subclasses of one another.
    if isinstance(exc, BudgetExhaustedError):
        return _permanent("budget_exhausted")
    if isinstance(exc, DeadlineExceededError):
        return _permanent("timed_out")
    if isinstance(exc, StructuredOutputError):
        return _permanent("invalid_structured_output")
    if isinstance(exc, json.JSONDecodeError):
        return _permanent("invalid_tool_arguments")

    if isinstance(exc, anthropic.APITimeoutError):
        return _transient("timeout")
    if isinstance(exc, anthropic.APIConnectionError):
        return _transient("network")
    if isinstance(exc, anthropic.APIStatusError):
        return _from_status(exc.status_code, exc.body)

    if isinstance(exc, (httpx.TimeoutException, requests.Timeout)):
        return _transient("timeout")
    if isinstance(exc, (httpx.NetworkError, httpx.RemoteProtocolError, requests.ConnectionError)):
        if isinstance(exc, requests.exceptions.SSLError):
            return _permanent("configuration")
        return _transient("network")
    if isinstance(exc, requests.HTTPError):
        return _from_status(getattr(exc.response, "status_code", None))

    # redis.AuthenticationError subclasses redis.ConnectionError.
    if isinstance(exc, redis.exceptions.AuthenticationError):
        return _permanent("authentication")
    if isinstance(exc, (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError, pymongo.errors.ConnectionFailure)):
        return _transient("infrastructure")

    if isinstance(exc, PermissionError):
        return _permanent("permission_denied")
    if isinstance(exc, TimeoutError):
        return _transient("timeout")
    if isinstance(exc, ConnectionError):
        return _transient("network")
    return _permanent("unclassified")
