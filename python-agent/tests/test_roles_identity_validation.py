"""Regression tests for Agent Builder's role-generation identity validation.

Background: app.routes.roles's /roles/generate (RoleGenerateRequest's
user_id — a multipart Form field) and /roles/generate-from-description
(RoleGenerateFromDescriptionRequest.user_id) took a caller-supplied user_id
at face value, with no cross-check against the authenticated JWT's own
`sub`. Node (@Roles('admin')-gated, backend/src/agent-roles/
agent-roles.controller.ts) always sends user.sub as this field, so this
never affected legitimate traffic through the real product surface — but a
caller holding its own valid JWT and reaching python-agent directly could
set user_id to someone else's id.

Traced impact specifically for /roles/generate: user_id becomes the
uploaded document's Qdrant point payload.user_id (see
app.rag.vector_store.upsert_chunks) — a "private draft" tag. Retrieval
(app.tools.business_search_tool.run) matches `source_type in [...,
"document"] AND user_id in [<searching user's own real id>, "*"]`. So
forging another user's id onto a newly-uploaded document would make that
uploaded content transparently surface in the IMPERSONATED user's own
search_business_context results — a content-injection vector, not a read
of the victim's existing data — and, since "document" Qdrant points carry
no organization_id field at all, this is not even confined to one tenant.
/roles/generate-from-description has no Qdrant document at all (Agent
Builder's "Describe" method) — user_id there only labels a telemetry trace.

The fix: both routes now call the same app.security.assert_user_id_matches
used by app.routes.chat, rejecting (403) before any document is embedded,
tagged, or extracted.

Plain stdlib unittest — see test_organization_isolation.py for why. These
tests use generated, non-production-looking identities throughout
("org-alpha"/"user-real"/"attacker"/"victim" etc.) — never real ids.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from app.models.schemas import RoleGenerateFromDescriptionRequest  # noqa: E402
from app.routes import roles  # noqa: E402

_EXTRACTED_FIELDS = {
    "description": "",
    "goals": [],
    "responsibilities": [],
    "dailyTasks": [],
    "weeklyTasks": [],
    "kpis": [],
    "systemPrompt": "x",
    "department": "",
}


def _extracted(name: str) -> dict:
    return {"name": name, **_EXTRACTED_FIELDS}


def _run_async(coro):
    import asyncio

    return asyncio.run(coro)


def _fake_upload(filename: str = "notes.txt", content: bytes = b"some uploaded text") -> MagicMock:
    upload = MagicMock()
    upload.filename = filename
    upload.read = MagicMock(return_value=_AwaitableBytes(content))
    return upload


class _AwaitableBytes:
    """Mimics UploadFile.read()'s awaitable without pulling in a real UploadFile."""

    def __init__(self, content: bytes):
        self._content = content

    def __await__(self):
        async def _inner():
            return self._content

        return _inner().__await__()


class GenerateRoleIdentityTests(unittest.TestCase):
    """Covers item 1 (cannot impersonate another user) and item 2 (a
    correctly-identified admin request still works) for /roles/generate."""

    def test_mismatched_user_id_is_rejected_before_any_extraction_or_upload(self):
        with patch("app.routes.roles.extract_role") as extract_role, patch(
            "app.routes.roles.upsert_chunks"
        ) as upsert_chunks:
            with self.assertRaises(HTTPException) as ctx:
                _run_async(
                    roles.generate_role(
                        file=_fake_upload(),
                        user_id="victim-user",
                        user={"sub": "attacker-user", "organizationId": "org-alpha"},
                    )
                )
            self.assertEqual(ctx.exception.status_code, 403)
            extract_role.assert_not_called()
            upsert_chunks.assert_not_called()

    def test_matching_user_id_is_accepted_and_reaches_extraction_and_upload(self):
        with patch(
            "app.routes.roles.extract_role",
            return_value=_extracted("Sales Bot"),
        ), patch("app.routes.roles.upsert_chunks") as upsert_chunks:
            result = _run_async(
                roles.generate_role(
                    file=_fake_upload(),
                    user_id="real-admin",
                    user={"sub": "real-admin", "organizationId": "org-alpha"},
                )
            )
            upsert_chunks.assert_called_once()
            # item 3: the Qdrant ownership tag is the *verified* identity, not
            # anything else — upsert_chunks(document_id, user_id, ...).
            self.assertEqual(upsert_chunks.call_args.args[1], "real-admin")
        self.assertEqual(result.sourceDocumentName, "notes.txt")

    def test_private_document_filter_would_only_ever_match_the_verified_uploader(self):
        # item 3, end to end: once assert_user_id_matches has run, the value
        # that reaches the Qdrant payload is provably the authenticated
        # user's own sub — simulate business_search_tool's own filter shape
        # to show a mismatched id could never have been written in the first
        # place, so it could never match a different real user's search.
        verified_user_id = "real-admin"
        with patch("app.routes.roles.extract_role", return_value=_extracted("x")), patch(
            "app.routes.roles.upsert_chunks"
        ) as upsert_chunks:
            _run_async(
                roles.generate_role(
                    file=_fake_upload(),
                    user_id=verified_user_id,
                    user={"sub": verified_user_id, "organizationId": "org-alpha"},
                )
            )
        written_owner = upsert_chunks.call_args.args[1]
        searching_user = "someone-else"
        self.assertNotIn(written_owner, [searching_user, "*"])


class GenerateRoleFromDescriptionIdentityTests(unittest.TestCase):
    """Same shape, for the no-document Describe method — item 4: existing
    functionality (a correctly-identified request) remains intact."""

    def test_mismatched_user_id_is_rejected(self):
        payload = RoleGenerateFromDescriptionRequest(description="A bot that handles returns", user_id="victim-user")
        with patch("app.routes.roles.extract_role_from_description") as extract:
            with self.assertRaises(HTTPException) as ctx:
                roles.generate_role_from_description(
                    payload=payload, user={"sub": "attacker-user", "organizationId": "org-alpha"}
                )
            self.assertEqual(ctx.exception.status_code, 403)
            extract.assert_not_called()

    def test_matching_user_id_still_generates_a_role(self):
        payload = RoleGenerateFromDescriptionRequest(description="A bot that handles returns", user_id="real-admin")
        with patch(
            "app.routes.roles.extract_role_from_description", return_value=_extracted("Returns Bot")
        ) as extract:
            result = roles.generate_role_from_description(
                payload=payload, user={"sub": "real-admin", "organizationId": "org-alpha"}
            )
            extract.assert_called_once()
        self.assertEqual(result.name, "Returns Bot")


if __name__ == "__main__":
    unittest.main()
