"""Regression tests for ChatRequest.user_id identity validation.

Background: app.routes.chat's /chat and /chat/stream took payload.user_id
(a request-body field) at face value for billing attribution
(billing_client.reserve/settle/release), Mem0 memory search/write
(_system_prompt_with_memory / _extract_memory_in_background), and
conversation-history reads (get_recent_messages) — never cross-checked
against the authenticated JWT's own `sub` claim. Node (the intended, and
per app.security.get_current_user's docstring, the only truly trusted
caller) always sends a matching value, so this never affected legitimate
traffic — but nothing stopped a caller holding its OWN valid JWT from
setting user_id to someone else's id directly, which would have billed
usage under another identity, leaked another user's Mem0 memories into the
caller's own system prompt, written forged memories under another user's
id, and (before the organization_isolation fix in this same change) read
another user's conversation history.

The fix: app.security.assert_user_id_matches() rejects any request where
user_id != user["sub"] with 403, called as the first line of both /chat and
/chat/stream (passing payload.user_id) — closing every one of those
downstream consumers in one place, since none of them is reached if the
check fails. The same shared helper is reused by app.routes.roles for the
identical user_id-impersonation shape on the Agent Builder generate/
generate-from-description routes (see test_roles_identity_validation.py).
get_recent_messages() was additionally tightened to require a userId match
(not just organizationId), matching Conversation.userId's own documented
role as this collection's real ownership key (see conversation.schema.ts).

Plain stdlib unittest — see test_organization_isolation.py for why.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from app.memory.conversation_store import get_recent_messages  # noqa: E402
from app.models.schemas import ChatRequest  # noqa: E402
from app.security import assert_user_id_matches  # noqa: E402


def _request(**overrides) -> ChatRequest:
    defaults = dict(user_id="user-real", conversation_id="conv-1", message="hi", agent_id=None)
    defaults.update(overrides)
    return ChatRequest(**defaults)


class AssertUserIdMatchesTests(unittest.TestCase):
    def test_matching_user_id_passes_silently(self):
        assert_user_id_matches(_request(user_id="user-real").user_id, {"sub": "user-real", "organizationId": "org-1"})

    def test_mismatched_user_id_is_rejected_with_403(self):
        with self.assertRaises(HTTPException) as ctx:
            assert_user_id_matches(
                _request(user_id="someone-else").user_id, {"sub": "user-real", "organizationId": "org-1"}
            )
        self.assertEqual(ctx.exception.status_code, 403)

    def test_empty_user_id_against_a_real_sub_is_rejected(self):
        with self.assertRaises(HTTPException):
            assert_user_id_matches(_request(user_id="").user_id, {"sub": "user-real", "organizationId": "org-1"})


class GetRecentMessagesOwnershipScopingTests(unittest.TestCase):
    """Pure-logic tests of the guard/query shape — mocks get_db() so no real
    Mongo connection is needed."""

    def test_missing_user_id_fails_closed_without_querying_mongo(self):
        with patch("app.memory.conversation_store.get_db") as get_db, patch(
            "app.memory.conversation_store.get_json", return_value=None
        ):
            result = get_recent_messages("conv-1", None, "org-1")
            get_db.assert_not_called()
        self.assertEqual(result, [])

    def test_missing_organization_id_fails_closed_without_querying_mongo(self):
        with patch("app.memory.conversation_store.get_db") as get_db, patch(
            "app.memory.conversation_store.get_json", return_value=None
        ):
            result = get_recent_messages("conv-1", "user-real", None)
            get_db.assert_not_called()
        self.assertEqual(result, [])

    def test_query_is_scoped_by_both_user_id_and_organization_id(self):
        fake_db = MagicMock()
        fake_db.conversations.find_one.return_value = None
        with patch("app.memory.conversation_store.get_db", return_value=fake_db), patch(
            "app.memory.conversation_store.get_json", return_value=None
        ), patch("app.memory.conversation_store.set_json"):
            get_recent_messages("507f1f77bcf86cd799439011", "user-real", "org-1")
        fake_db.conversations.find_one.assert_called_once()
        query = fake_db.conversations.find_one.call_args.args[0]
        self.assertEqual(query.get("userId"), "user-real")
        self.assertEqual(query.get("organizationId"), "org-1")

    def test_cache_key_differs_for_different_users_on_the_same_conversation_id(self):
        # A cache hit must never let user B's request serve user A's cached
        # history for the same conversation_id — proven by the cache key
        # itself differing, not just the (already-tested) DB query.
        from app.memory import conversation_store

        key_a = conversation_store.cache_key(
            "conversation", "conv-1", {"limit": 20, "organization_id": "org-1", "user_id": "user-a"}
        )
        key_b = conversation_store.cache_key(
            "conversation", "conv-1", {"limit": 20, "organization_id": "org-1", "user_id": "user-b"}
        )
        self.assertNotEqual(key_a, key_b)


if __name__ == "__main__":
    unittest.main()
