"""Approximate USD cost from token usage. Pricing is env-overridable since
list prices change over time and vary by exact model — treat these figures
as estimates for relative cost tracking, not billing-accurate numbers.

Provider-aware AND model-aware: Claude Opus/Sonnet/Haiku have materially
different per-token prices, so applying one flat Anthropic rate to every
model (the old behavior of this file) silently over- or under-counts cost
whenever more than one Claude model is in use (see
app.config.settings.anthropic_model vs anthropic_routing_model — this app
already calls two different model tiers). Matching is done by substring on
the model name ("opus"/"sonnet"/"haiku") rather than an exact-string table,
so a version bump (e.g. "claude-opus-5" vs "claude-opus-4.5") still resolves
to the right family without a code change.

Anthropic also prices prompt-cache writes/reads differently from a plain
input token (see anthropic_client.py's `cache_control: {"type": "ephemeral"}`
usage) — a cache write is charged at a documented multiple of the base input
rate, a cache read at a smaller fraction of it. These multipliers are the
stable part of Anthropic's pricing convention even as base rates change
across model generations, so they're modeled as multipliers on each family's
own input rate rather than separate absolute prices to keep in sync.
"""

import os


def _rate(env_var: str, default: float) -> float:
    return float(os.environ.get(env_var, default))


# (input $/MTok, output $/MTok) per Claude model family. Matched by substring
# against the configured model name — see module docstring. Update these
# via env vars (or here directly) when Anthropic's published pricing changes;
# this is the ONLY place Claude pricing is defined in this app.
_ANTHROPIC_FAMILY_RATES: list[tuple[str, tuple[float, float]]] = [
    ("opus", (_rate("ANTHROPIC_OPUS_INPUT_COST_PER_MTOK", 15.0), _rate("ANTHROPIC_OPUS_OUTPUT_COST_PER_MTOK", 75.0))),
    ("haiku", (_rate("ANTHROPIC_HAIKU_INPUT_COST_PER_MTOK", 0.80), _rate("ANTHROPIC_HAIKU_OUTPUT_COST_PER_MTOK", 4.0))),
    # Sonnet-class is also the fallback default for an unrecognized Claude
    # model name, matching this file's previous (pre-model-aware) behavior.
    ("sonnet", (_rate("ANTHROPIC_SONNET_INPUT_COST_PER_MTOK", 3.0), _rate("ANTHROPIC_SONNET_OUTPUT_COST_PER_MTOK", 15.0))),
]
_ANTHROPIC_DEFAULT_RATES = _ANTHROPIC_FAMILY_RATES[-1][1]

# Documented Anthropic prompt-caching multipliers, applied to the resolved
# model family's own input rate (NOT a separate absolute price table).
_CACHE_WRITE_MULTIPLIER = _rate("ANTHROPIC_CACHE_WRITE_MULTIPLIER", 1.25)
_CACHE_READ_MULTIPLIER = _rate("ANTHROPIC_CACHE_READ_MULTIPLIER", 0.10)

# Groq's Llama-3.3-70B list pricing as of this app's default groq_model (see
# app.config.settings.groq_model) — override if a different model is
# configured, since Groq's per-model rates vary more than a single constant.
_GROQ_RATES = (
    _rate("GROQ_INPUT_COST_PER_MTOK", 0.59),
    _rate("GROQ_OUTPUT_COST_PER_MTOK", 0.79),
)


def _anthropic_rates(model: str) -> tuple[float, float]:
    model_lower = model.lower()
    for needle, rates in _ANTHROPIC_FAMILY_RATES:
        if needle in model_lower:
            return rates
    return _ANTHROPIC_DEFAULT_RATES


def estimate_cost(
    input_tokens: int,
    output_tokens: int,
    provider: str = "anthropic",
    model: str = "",
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> float | None:
    """Returns None (shown as "—" in the UI) for an unrecognized provider —
    a fabricated number would be actively misleading, unlike a missing one.

    total cost = input*input_rate + output*output_rate
               + cache_creation*(input_rate * write_multiplier)
               + cache_read*(input_rate * read_multiplier)

    Anthropic's `input_tokens` field on the API response does NOT include
    cache_creation/cache_read tokens (they're reported separately) — so this
    sum never double-counts a token across the four buckets.
    """
    if provider == "anthropic":
        input_rate, output_rate = _anthropic_rates(model)
        cost = (input_tokens / 1_000_000) * input_rate + (output_tokens / 1_000_000) * output_rate
        if cache_creation_input_tokens:
            cost += (cache_creation_input_tokens / 1_000_000) * (input_rate * _CACHE_WRITE_MULTIPLIER)
        if cache_read_input_tokens:
            cost += (cache_read_input_tokens / 1_000_000) * (input_rate * _CACHE_READ_MULTIPLIER)
        return cost
    if provider == "groq":
        input_rate, output_rate = _GROQ_RATES
        return (input_tokens / 1_000_000) * input_rate + (output_tokens / 1_000_000) * output_rate
    return None
