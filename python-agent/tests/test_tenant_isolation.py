"""Run from python-agent/ with: .venv/Scripts/python -m unittest discover -s tests -t ."""

import unittest
from unittest.mock import patch

import jwt
from qdrant_client.http import models as qmodels

from app.integrations.prospectconnect import _cache_namespace
from app.memory import working_memory
from app.rag import vector_store
from app.tools.business_search_tool import _search_filter


def conditions(branch):
    return {c.key: (c.match.any if isinstance(c.match, qmodels.MatchAny) else c.match.value) for c in branch.must}


class SearchFilterTests(unittest.TestCase):
    CRM = ["crm_contact", "crm_deal"]

    def test_shared_points_require_this_business(self):
        result = _search_filter(self.CRM, "user-1", "org-a")
        branches = [conditions(b) for b in result.should]
        self.assertEqual(branches[0], {"source_type": self.CRM, "user_id": "user-1"})
        self.assertEqual(branches[1], {"source_type": self.CRM, "user_id": "*", "organization_id": "org-a"})

    def test_no_branch_matches_shared_points_without_a_business(self):
        for branch in _search_filter(self.CRM, "user-1", "org-a").should:
            found = conditions(branch)
            if found["user_id"] == "*":
                self.assertEqual(found["organization_id"], "org-a")

    def test_no_organization_never_reaches_shared_points(self):
        self.assertEqual(conditions(_search_filter(self.CRM, "user-1", None)), {"source_type": self.CRM, "user_id": "user-1"})

    def test_scheduled_reports_acting_as_star_stay_inside_their_business(self):
        self.assertEqual(
            conditions(_search_filter(self.CRM, "*", "org-a")),
            {"source_type": self.CRM, "user_id": "*", "organization_id": "org-a"},
        )
        self.assertIsNone(_search_filter(self.CRM, "*", None))

    def test_business_knowledge_is_scoped_by_business_alone(self):
        types = ["business_profile"]
        self.assertEqual(conditions(_search_filter(types, "user-1", "org-a")), {"source_type": types, "organization_id": "org-a"})
        self.assertIsNone(_search_filter(types, "user-1", None))

    def test_two_businesses_get_different_filters(self):
        self.assertNotEqual(_search_filter(self.CRM, "u", "org-a"), _search_filter(self.CRM, "u", "org-b"))


class CrmCacheTests(unittest.TestCase):
    ROOT = "http://backend/crm"

    def token(self, organization_id, nonce="1"):
        return "Bearer " + jwt.encode({"sub": "u", "organizationId": organization_id, "n": nonce}, "k" * 32, algorithm="HS256")

    def test_built_in_crm_is_separate_per_business(self):
        self.assertNotEqual(_cache_namespace(self.ROOT, self.token("org-a")), _cache_namespace(self.ROOT, self.token("org-b")))

    def test_built_in_crm_cache_survives_a_fresh_token_for_the_same_business(self):
        self.assertEqual(_cache_namespace(self.ROOT, self.token("org-a", "1")), _cache_namespace(self.ROOT, self.token("org-a", "2")))

    def test_same_hosted_crm_with_different_keys_is_separate(self):
        host = "https://crm.example.com"
        self.assertNotEqual(_cache_namespace(host, "key-a"), _cache_namespace(host, "key-b"))

    def test_the_key_itself_is_never_in_the_cache_key(self):
        self.assertNotIn("secret-key", _cache_namespace("https://crm.example.com", "secret-key"))

    def test_a_malformed_token_still_gets_its_own_namespace(self):
        self.assertNotEqual(_cache_namespace(self.ROOT, "Bearer not-a-token"), _cache_namespace(self.ROOT, "Bearer other"))


class ToolCacheTests(unittest.TestCase):
    def test_scheduled_reports_in_two_businesses_do_not_share_results(self):
        seen = []
        with (
            patch.object(working_memory, "_is_cacheable", return_value=True),
            patch.object(working_memory, "get_json", side_effect=lambda key: seen.append(key)),
            patch.object(working_memory, "set_json"),
            patch.object(working_memory, "execute_tool", return_value="result"),
        ):
            working_memory.cached_execute_tool("crm_contact", {"q": "x"}, {"user_id": "*", "organization_id": "org-a"})
            working_memory.cached_execute_tool("crm_contact", {"q": "x"}, {"user_id": "*", "organization_id": "org-b"})
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0], seen[1])


class SharedDocumentTests(unittest.TestCase):
    def test_publishing_a_role_document_records_its_business(self):
        with patch.object(vector_store, "ensure_collection"), patch.object(vector_store, "get_client") as client:
            vector_store.reassign_owner("doc-1", "*", "org-a")
        payload = client.return_value.set_payload.call_args.kwargs["payload"]
        self.assertEqual(payload, {"user_id": "*", "organization_id": "org-a"})


if __name__ == "__main__":
    unittest.main()
