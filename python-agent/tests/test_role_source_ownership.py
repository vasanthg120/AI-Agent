"""Regression tests for Agent Builder source-document ownership authorization.

Background: app.routes.roles's /roles/publish-source and /roles/discard-
source took only a documentId (app.models.schemas.SourceRef) and performed
no ownership check at all — reassign_owner(document_id, "*") and
delete_by_document_id(document_id) act on ANY documentId a caller supplies.
Through the normal product surface this is unreachable (Node's
agent-roles.service.ts update()/remove() always derives documentId from an
AgentRole record it has ALREADY verified belongs to the caller's own org —
backend/src/agent-roles/agent-roles.service.ts:154,189's
`roleModel.findOne({_id, organizationId})` — never from client input), but
a caller reaching python-agent directly with its own valid JWT and an
arbitrary documentId could publish (make globally searchable) or discard
(permanently delete) any other organization's draft or active role source,
with no identity check of any kind.

Why the fix doesn't check the Qdrant point's own user_id payload: that tag
goes from a real uploader id to the shared "*" sentinel the moment a role
is published (see reassign_owner) — checking it would correctly authorize
nothing for the legitimate "delete an already-active role" path, which is
exactly the case remove() hits for any previously-published role.

The fix: _assert_may_manage_source() looks up the SAME persisted
organizationId-scoped ownership record Node's own update()/remove() already
check — a matching AgentRole document in the backend's shared agent_roles
collection (python-agent already reads this collection read-only elsewhere,
see app.agent.personas.resolve_persona) — using the caller's trusted JWT
organizationId and roles, never a request-body field. Admin is required,
matching every other Agent Builder mutation's existing @Roles('admin') gate.

Plain stdlib unittest — see test_organization_isolation.py for why. Uses
only dynamically generated identities/org ids/document ids (uuid4-based),
never anything resembling a real production value.
"""

import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from app.models.schemas import SourceRef  # noqa: E402
from app.routes import roles  # noqa: E402


def _org() -> str:
    return f"org-{uuid.uuid4()}"


def _doc() -> str:
    return str(uuid.uuid4())


def _owning_role_db(document_id: str, organization_id: str) -> MagicMock:
    """A fake Mongo handle whose agent_roles.find_one only matches the
    exact (sourceDocumentId, organizationId) pair real data would have —
    anything else (wrong org, wrong document, or both) returns None,
    exactly like a real org-scoped query would."""
    db = MagicMock()

    def find_one(query):
        if query.get("sourceDocumentId") == document_id and query.get("organizationId") == organization_id:
            return {"_id": "role-doc-id", "sourceDocumentId": document_id, "organizationId": organization_id}
        return None

    db.agent_roles.find_one.side_effect = find_one
    return db


class PublishSourceOwnershipTests(unittest.TestCase):
    def test_cannot_publish_another_organizations_source(self):
        owner_org, attacker_org = _org(), _org()
        document_id = _doc()
        fake_db = _owning_role_db(document_id, owner_org)

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.reassign_owner"
        ) as reassign_owner:
            with self.assertRaises(HTTPException) as ctx:
                roles.publish_source(
                    payload=SourceRef(documentId=document_id),
                    user={"sub": "attacker-user", "organizationId": attacker_org, "roles": ["admin"]},
                )
            self.assertEqual(ctx.exception.status_code, 403)
            reassign_owner.assert_not_called()

    def test_legitimate_owner_can_still_publish_their_own_source(self):
        owner_org = _org()
        document_id = _doc()
        fake_db = _owning_role_db(document_id, owner_org)

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.reassign_owner"
        ) as reassign_owner:
            result = roles.publish_source(
                payload=SourceRef(documentId=document_id),
                user={"sub": "owner-admin", "organizationId": owner_org, "roles": ["admin"]},
            )
            reassign_owner.assert_called_once_with(document_id, "*")
        self.assertEqual(result, {"status": "published"})

    def test_cross_organization_access_is_rejected_even_with_a_valid_admin_token(self):
        owner_org, other_org = _org(), _org()
        document_id = _doc()
        fake_db = _owning_role_db(document_id, owner_org)

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.reassign_owner"
        ) as reassign_owner:
            with self.assertRaises(HTTPException) as ctx:
                roles.publish_source(
                    payload=SourceRef(documentId=document_id),
                    user={"sub": "some-other-orgs-admin", "organizationId": other_org, "roles": ["admin"]},
                )
            self.assertEqual(ctx.exception.status_code, 403)
            reassign_owner.assert_not_called()

    def test_a_non_admin_in_the_correct_org_is_still_rejected(self):
        # Matches the existing policy everywhere else in Agent Builder:
        # generate/create/update/remove are all @Roles('admin')-only.
        owner_org = _org()
        document_id = _doc()
        fake_db = _owning_role_db(document_id, owner_org)

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.reassign_owner"
        ) as reassign_owner:
            with self.assertRaises(HTTPException) as ctx:
                roles.publish_source(
                    payload=SourceRef(documentId=document_id),
                    user={"sub": "manager-in-right-org", "organizationId": owner_org, "roles": ["manager"]},
                )
            self.assertEqual(ctx.exception.status_code, 403)
            reassign_owner.assert_not_called()

    def test_missing_organization_context_cannot_bypass_authorization(self):
        document_id = _doc()
        fake_db = _owning_role_db(document_id, _org())

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.reassign_owner"
        ) as reassign_owner:
            with self.assertRaises(HTTPException) as ctx:
                roles.publish_source(
                    payload=SourceRef(documentId=document_id),
                    user={"sub": "service-token-no-org"},  # e.g. a short-lived internal token, no org/roles claims
                )
            self.assertEqual(ctx.exception.status_code, 403)
            reassign_owner.assert_not_called()
            fake_db.agent_roles.find_one.assert_not_called()


class DiscardSourceOwnershipTests(unittest.TestCase):
    def test_cannot_discard_another_organizations_source(self):
        owner_org, attacker_org = _org(), _org()
        document_id = _doc()
        fake_db = _owning_role_db(document_id, owner_org)

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.delete_by_document_id"
        ) as delete_by_document_id:
            with self.assertRaises(HTTPException) as ctx:
                roles.discard_source(
                    payload=SourceRef(documentId=document_id),
                    user={"sub": "attacker-user", "organizationId": attacker_org, "roles": ["admin"]},
                )
            self.assertEqual(ctx.exception.status_code, 403)
            delete_by_document_id.assert_not_called()

    def test_legitimate_owner_can_still_discard_their_own_source(self):
        owner_org = _org()
        document_id = _doc()
        fake_db = _owning_role_db(document_id, owner_org)

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.delete_by_document_id"
        ) as delete_by_document_id:
            result = roles.discard_source(
                payload=SourceRef(documentId=document_id),
                user={"sub": "owner-admin", "organizationId": owner_org, "roles": ["admin"]},
            )
            delete_by_document_id.assert_called_once_with(document_id)
        self.assertEqual(result, {"status": "discarded"})

    def test_discard_also_works_for_an_already_published_role(self):
        # The exact case that would break if ownership were checked against
        # the Qdrant point's own user_id payload instead of the AgentRole
        # record: after publish_source, that payload is "*", not a real
        # user id — the AgentRole-based check must still authorize this.
        owner_org = _org()
        document_id = _doc()
        fake_db = _owning_role_db(document_id, owner_org)

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.delete_by_document_id"
        ) as delete_by_document_id:
            roles.discard_source(
                payload=SourceRef(documentId=document_id),
                user={"sub": "owner-admin", "organizationId": owner_org, "roles": ["admin"]},
            )
            delete_by_document_id.assert_called_once()

    def test_unverified_identity_cannot_bypass_authorization(self):
        # No sub/roles/organizationId at all (shouldn't happen behind
        # get_current_user, but this function must not assume it) — must
        # still fail closed, not crash into an unscoped lookup.
        document_id = _doc()
        fake_db = _owning_role_db(document_id, _org())

        with patch("app.routes.roles.get_db", return_value=fake_db), patch(
            "app.routes.roles.delete_by_document_id"
        ) as delete_by_document_id:
            with self.assertRaises(HTTPException) as ctx:
                roles.discard_source(payload=SourceRef(documentId=document_id), user={})
            self.assertEqual(ctx.exception.status_code, 403)
            delete_by_document_id.assert_not_called()
            fake_db.agent_roles.find_one.assert_not_called()


if __name__ == "__main__":
    unittest.main()
