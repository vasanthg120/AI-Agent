"""Tests for app.agent.dynamic.org_limits — Phase 4's per-organization
override of the Phase 2 global safety limits, extended in Phase 2.5
Sub-step C with 5 more fields (see the plan's "Dynamic Recursive
Multi-Agent System" section).

Every test mocks app.agent.dynamic.org_limits.get_db (no real Mongo) and
resets the module's own cache between tests (it's a plain module-level dict,
not torn down automatically) — this file is about org_limits' own
resolve/clamp/cache logic. test_dynamic_agents_master.py separately proves
master_agent.run_task() actually uses whatever resolve() returns.

resolve() returns an OrgDynamicAgentLimits NamedTuple (not a bare tuple) —
every test below reads it via attribute access, never positional
unpacking, so adding yet another field later never breaks every existing
call site here again.

Plain stdlib unittest, matching this project's existing convention. Run with:
    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent.dynamic import org_limits  # noqa: E402

VALID_OID = "507f1f77bcf86cd799439011"  # a well-formed, 24-hex-char ObjectId — no real document needs to exist for it

# Patched onto every field org_limits.limits exposes, for tests that need a
# known, stable platform ceiling across the board rather than just one field.
_ALL_CEILINGS = {
    "MAX_DEPTH": 2, "MAX_AGENTS_PER_REQUEST": 6, "MAX_EXECUTION_SECONDS": 180,
    "MAX_RETRIES": 2, "MAX_MODEL_CALLS": 40, "MAX_TOOL_CALLS": 60, "MAX_TOKENS": 500_000, "MAX_COST_USD": 2.0,
}


def _patch_all_ceilings():
    return [patch(f"app.agent.dynamic.org_limits.limits.{name}", value) for name, value in _ALL_CEILINGS.items()]


class OrgLimitsTests(unittest.TestCase):
    def setUp(self):
        org_limits._cache.clear()
        self._patches = _patch_all_ceilings()
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def test_no_organization_id_returns_platform_defaults_without_touching_mongo(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            result = org_limits.resolve(None)

        self.assertEqual(
            result,
            org_limits.OrgDynamicAgentLimits(
                max_depth=2, max_agents_per_request=6, max_execution_seconds=180,
                max_retries=2, max_model_calls=40, max_tool_calls=60, max_tokens=500_000, max_cost_usd=2.0,
            ),
        )
        get_db.assert_not_called()

    def test_a_non_object_id_shaped_organization_id_falls_back_without_touching_mongo(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            result = org_limits.resolve("org-1")

        self.assertEqual(result.max_depth, 2)
        get_db.assert_not_called()

    def test_no_saved_document_falls_back_to_platform_defaults(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = None
            result = org_limits.resolve(VALID_OID)

        self.assertEqual(result.max_depth, 2)

    def test_an_override_tighter_than_the_platform_default_is_honored_for_every_field(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {
                "dynamicAgentsSettings": {
                    "maxDepth": 1, "maxAgentsPerRequest": 3, "maxExecutionSeconds": 60,
                    "maxRetries": 1, "maxModelCalls": 10, "maxToolCalls": 15, "maxTokens": 1000, "maxCostUsd": 0.5,
                }
            }
            result = org_limits.resolve(VALID_OID)

        self.assertEqual(result.max_depth, 1)
        self.assertEqual(result.max_agents_per_request, 3)
        self.assertEqual(result.max_execution_seconds, 60)
        self.assertEqual(result.max_retries, 1)
        self.assertEqual(result.max_model_calls, 10)
        self.assertEqual(result.max_tool_calls, 15)
        self.assertEqual(result.max_tokens, 1000)
        self.assertEqual(result.max_cost_usd, 0.5)

    def test_maxdepth_and_maxretries_zero_are_legitimate_tightenings_not_invalid_values(self):
        # Unlike every other field here, 0 is documented and meaningful for
        # depth ("this agent only, never decomposes" — app.config's
        # dynamic_agents_max_depth comment) and for retries ("never retry").
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {
                "dynamicAgentsSettings": {"maxDepth": 0, "maxRetries": 0}
            }
            result = org_limits.resolve(VALID_OID)

        self.assertEqual(result.max_depth, 0)
        self.assertEqual(result.max_retries, 0)

    def test_an_override_looser_than_the_platform_default_is_clamped_down_never_loosened(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {
                "dynamicAgentsSettings": {"maxDepth": 99, "maxTokens": 10_000_000, "maxCostUsd": 999.0}
            }
            result = org_limits.resolve(VALID_OID)

        self.assertEqual(result.max_depth, 2)  # never allowed past the platform ceiling
        self.assertEqual(result.max_tokens, 500_000)
        self.assertEqual(result.max_cost_usd, 2.0)

    def test_an_invalid_saved_depth_negative_wrong_type_falls_back_to_the_platform_default(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            for bad_value in (-1, "two", None, True):
                with self.subTest(bad_value=bad_value):
                    org_limits._cache.clear()
                    get_db.return_value.organizations.find_one.return_value = {
                        "dynamicAgentsSettings": {"maxDepth": bad_value}
                    }
                    result = org_limits.resolve(VALID_OID)
                    self.assertEqual(result.max_depth, 2)

    def test_zero_is_invalid_for_every_field_except_depth_and_retries(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {
                "dynamicAgentsSettings": {
                    "maxAgentsPerRequest": 0, "maxExecutionSeconds": 0,
                    "maxModelCalls": 0, "maxToolCalls": 0, "maxTokens": 0, "maxCostUsd": 0,
                }
            }
            result = org_limits.resolve(VALID_OID)

        self.assertEqual(result.max_agents_per_request, 6)
        self.assertEqual(result.max_execution_seconds, 180)
        self.assertEqual(result.max_model_calls, 40)
        self.assertEqual(result.max_tool_calls, 60)
        self.assertEqual(result.max_tokens, 500_000)
        self.assertEqual(result.max_cost_usd, 2.0)

    def test_a_mongo_failure_falls_back_to_platform_defaults_instead_of_raising(self):
        with patch("app.agent.dynamic.org_limits.get_db", side_effect=RuntimeError("mongo down")):
            result = org_limits.resolve(VALID_OID)

        self.assertEqual(result.max_depth, 2)

    def test_a_second_resolve_within_the_ttl_reuses_the_cache_and_never_hits_mongo_again(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {"dynamicAgentsSettings": {"maxDepth": 1}}
            org_limits.resolve(VALID_OID)
            org_limits.resolve(VALID_OID)
            org_limits.resolve(VALID_OID)

        self.assertEqual(get_db.return_value.organizations.find_one.call_count, 1)

    def test_organization_isolation_two_organizations_resolve_independently(self):
        other_oid = "507f1f77bcf86cd799439022"

        def fake_find_one(filter_, *_args, **_kwargs):
            if str(filter_["_id"]) == VALID_OID:
                return {"dynamicAgentsSettings": {"maxDepth": 1}}
            return {"dynamicAgentsSettings": {"maxDepth": 2}}

        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.side_effect = fake_find_one
            first = org_limits.resolve(VALID_OID)
            second = org_limits.resolve(other_oid)

        self.assertEqual(first.max_depth, 1)
        self.assertEqual(second.max_depth, 2)

    def test_cache_expiry_re_reads_mongo_after_the_ttl_elapses(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db, patch(
            "app.agent.dynamic.org_limits.time"
        ) as fake_time:
            get_db.return_value.organizations.find_one.return_value = {"dynamicAgentsSettings": {"maxDepth": 1}}
            fake_time.monotonic.return_value = 1000.0
            org_limits.resolve(VALID_OID)
            fake_time.monotonic.return_value = 1000.0 + org_limits._CACHE_TTL_SECONDS + 1
            org_limits.resolve(VALID_OID)

        self.assertEqual(get_db.return_value.organizations.find_one.call_count, 2)


class IsOrgEnabledTests(unittest.TestCase):
    """The per-organization rollout gate (production rollout) — required
    ALONGSIDE app.agent.dynamic.runner.ENABLED, not instead of it; see
    test_dynamic_agents_feature_flag.py for the combined-gate tests."""

    def setUp(self):
        org_limits._cache.clear()

    def test_no_organization_id_is_disabled(self):
        self.assertFalse(org_limits.is_org_enabled(None))

    def test_a_fresh_organization_with_no_saved_settings_is_disabled_opt_in_not_opt_out(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {"dynamicAgentsSettings": {}}
            self.assertFalse(org_limits.is_org_enabled(VALID_OID))

    def test_an_organization_with_enabled_true_is_enabled(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {"dynamicAgentsSettings": {"enabled": True}}
            self.assertTrue(org_limits.is_org_enabled(VALID_OID))

    def test_an_organization_with_enabled_explicitly_false_is_disabled(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {"dynamicAgentsSettings": {"enabled": False}}
            self.assertFalse(org_limits.is_org_enabled(VALID_OID))

    def test_a_non_boolean_truthy_value_is_never_treated_as_enabled(self):
        # Defense in depth against a malformed/directly-written Mongo value —
        # only the real boolean True counts, never "truthy" in Python's
        # general sense (a non-empty string, a stray 1, ...).
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {"dynamicAgentsSettings": {"enabled": "true"}}
            self.assertFalse(org_limits.is_org_enabled(VALID_OID))

    def test_organization_isolation_enabling_one_organization_never_enables_another(self):
        other_oid = "507f1f77bcf86cd799439033"

        def fake_find_one(filter_, *_args, **_kwargs):
            if str(filter_["_id"]) == VALID_OID:
                return {"dynamicAgentsSettings": {"enabled": True}}
            return {"dynamicAgentsSettings": {}}

        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.side_effect = fake_find_one
            self.assertTrue(org_limits.is_org_enabled(VALID_OID))
            self.assertFalse(org_limits.is_org_enabled(other_oid))

    def test_reuses_the_same_cache_resolve_already_populates_no_extra_mongo_round_trip(self):
        with patch("app.agent.dynamic.org_limits.get_db") as get_db:
            get_db.return_value.organizations.find_one.return_value = {"dynamicAgentsSettings": {"enabled": True, "maxDepth": 1}}
            org_limits.resolve(VALID_OID)
            org_limits.is_org_enabled(VALID_OID)

        self.assertEqual(get_db.return_value.organizations.find_one.call_count, 1)


if __name__ == "__main__":
    unittest.main()
