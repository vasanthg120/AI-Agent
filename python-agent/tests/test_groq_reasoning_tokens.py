"""Regression test for groq_client.py's reasoning-token read (see call()'s
streaming loop, around the `completion_tokens_details` getattr chain).

CompletionUsage.completion_tokens_details is Optional on the installed
groq==1.6.0 SDK, and CompletionTokensDetails.reasoning_tokens is itself
Optional within that — most Groq responses (non-reasoning models, or
reasoning_effort not requested) have no completion_tokens_details at all.
This must never raise regardless of which of those two levels is missing;
a usage-parsing bug here is wrapped in groq_client.py's own
`try: ... except: pass` around chunk.usage handling, but the read itself
should still be provably safe on its own.

Plain stdlib unittest, matching this project's existing test style. Run with:
    .venv/Scripts/python.exe -m pytest tests/test_groq_reasoning_tokens.py -v
"""

import unittest
from types import SimpleNamespace


def extract_reasoning_tokens(usage) -> int | None:
    """The exact read groq_client.py's call() performs on each usage-bearing
    chunk — extracted here so the three real shapes Groq's API can return
    are each tested directly, without mocking a whole streaming SDK client."""
    details = getattr(usage, "completion_tokens_details", None)
    return getattr(details, "reasoning_tokens", None) if details else None


class GroqReasoningTokensTests(unittest.TestCase):
    def test_no_completion_tokens_details_attribute_at_all(self):
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5)
        self.assertIsNone(extract_reasoning_tokens(usage))

    def test_completion_tokens_details_present_but_none(self):
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5, completion_tokens_details=None)
        self.assertIsNone(extract_reasoning_tokens(usage))

    def test_completion_tokens_details_present_with_no_reasoning_tokens_field(self):
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5, completion_tokens_details=SimpleNamespace())
        self.assertIsNone(extract_reasoning_tokens(usage))

    def test_real_reasoning_tokens_value_is_read_through(self):
        usage = SimpleNamespace(
            prompt_tokens=10,
            completion_tokens=5,
            completion_tokens_details=SimpleNamespace(reasoning_tokens=37),
        )
        self.assertEqual(extract_reasoning_tokens(usage), 37)


if __name__ == "__main__":
    unittest.main()
