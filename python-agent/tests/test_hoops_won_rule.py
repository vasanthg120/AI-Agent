"""Hoops read the way Hoops' own jobs report reads it (user, 2026-11-11):
- "Won" = a job was created (November: only job #2373, Sydney Children's
  Hospital Randwick Nutrition and Dietitian department), dated by the job;
- "Work in progress" = every job neither completed nor voided — what HaiVE's
  pipeline shows (`inPipeline`); a paid job is still in progress;
- an accepted quote with no job yet is open, and not in the pipeline.
Also the one-time re-classification of the sales already stored
(hoops_won_rule.py), which must change no more than the rule: no activity, no
lastActivityAt, admin-edited status words kept.

Plain stdlib unittest, matching this project's existing test style. Run with:
    .venv/Scripts/python.exe -m unittest tests.test_hoops_won_rule -v
"""

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from app.integrations import hoops
from app.integrations.crm_adapters import map_status
from app.integrations.hoops_won_rule import _update_for, reclassified, status_mapping_for

MAPPING = {"won": ["job"], "lost": ["voided"]}


def fields(**row):
    return hoops.transaction_fields({"_id": "t1", "createdAt": "2026-09-21T03:15:34Z", **row}, "AUD")


def job(number="2373", created="2026-11-02T00:10:00Z", **extra):
    return {"jobNumber": number, "jobCreatedAt": created, "jobs": [{"number": number, "createdAt": created, "voided": False, "completed": False, **extra}]}


class JobsReportRuleTests(unittest.TestCase):
    def test_a_new_job_is_won_on_the_day_the_job_was_created_and_is_work_in_progress(self):
        f = fields(status="ACCEPTED", accepted=True, acceptedAt="2026-11-01T22:00:00Z", number="4397", **job())
        self.assertEqual(map_status(f["_status"], MAPPING), "won")
        self.assertEqual(f["_closeDate"], "2026-11-02")  # the job's date, not the acceptance
        self.assertEqual(f["_stage"], hoops.IN_PRODUCTION)
        self.assertTrue(f["_inPipeline"])

    def test_a_paid_job_is_still_work_in_progress_until_hoops_completes_it(self):
        f = fields(status="Paid In square", invoice={"balance": 0, "transactionDate": "2026-07-01T00:00:00Z"}, **job("2124", "2026-06-20T00:00:00Z"))
        self.assertEqual(map_status(f["_status"], MAPPING), "won")
        self.assertTrue(f["_inPipeline"])

    def test_a_completed_job_stays_won_but_leaves_the_pipeline(self):
        f = fields(status="ACCEPTED", completed=True, **job("2008", "2026-04-01T00:00:00Z", completed=True))
        self.assertEqual(map_status(f["_status"], MAPPING), "won")
        self.assertEqual(f["_stage"], "Completed")
        self.assertFalse(f["_inPipeline"])

    def test_a_voided_job_is_neither_won_nor_in_the_pipeline(self):
        f = fields(status="ACCEPTED", voided=True, voidedAt="2026-10-30T00:00:00Z", **job("2358", "2026-10-20T00:00:00Z"))
        self.assertEqual(map_status(f["_status"], MAPPING), "lost")
        self.assertFalse(f["_inPipeline"])

    def test_a_job_whose_only_job_is_voided_does_not_count(self):
        row = job("2302")
        row["jobs"][0]["voided"] = True
        f = fields(status="FOLLOW UP 3", **row)
        self.assertNotEqual(map_status(f["_status"], MAPPING), "won")
        self.assertFalse(f["_inPipeline"])

    def test_an_accepted_quote_with_no_job_yet_is_open_and_not_in_the_pipeline(self):
        f = fields(status="ACCEPTED", accepted=True, acceptedAt="2026-11-02T00:00:00Z")
        self.assertEqual(map_status(f["_status"], MAPPING), "open")
        self.assertEqual(f["_stage"], hoops.ACCEPTED_NO_JOB)
        self.assertFalse(f["_inPipeline"])
        self.assertEqual(f["_quoteStatus"], "accepted")  # the quotation itself was still accepted

    def test_an_invoice_alone_is_not_the_sale_the_job_is(self):
        f = fields(status="SENT", invoice={"totalAmount": 100, "transactionDate": "2026-06-01T00:00:00Z"})
        self.assertNotEqual(map_status(f["_status"], MAPPING), "won")

    def test_a_won_sale_is_never_dated_by_its_last_edit(self):
        f = fields(status="ACCEPTED", jobNumber="1700", updatedAt="2026-11-03T09:00:00Z", createdAt="2025-03-17T01:00:00Z")
        self.assertEqual(f["_closeDate"], "2025-03-17")

    def test_the_day_is_the_businesss_own_not_utcs(self):
        # Job #2315 was created at 9:32am on 1 September in Sydney — still 31 August in UTC.
        row = {"status": "ACCEPTED", **job("2315", "2026-08-31T23:32:00Z")}
        self.assertEqual(fields(**row)["_closeDate"], "2026-08-31")  # no zone given: UTC, as before
        sydney = hoops.transaction_fields({"_id": "t1", **row}, "AUD", ZoneInfo("Australia/Sydney"))
        self.assertEqual(sydney["_closeDate"], "2026-09-01")

    def test_open_quotes_keep_their_own_step_and_stay_out_of_the_pipeline(self):
        f = fields(status="FOLLOW UP 2")
        self.assertEqual(map_status(f["_status"], MAPPING), "open")
        self.assertEqual(f["_stage"], "Follow up 2")
        self.assertFalse(f["_inPipeline"])


class OneTimeReclassificationTests(unittest.TestCase):
    def deal(self, **kw):
        base = {
            "_id": "d1",
            "externalId": "t1",
            "createdAt": datetime(2026, 9, 21, 3, 15),
            "dealStatus": "open",
            "stageId": "Accepted – not invoiced",
            "expectedClosingDate": "2026-10-21",
            "lastActivityAt": datetime(2026, 11, 2),
        }
        return {**base, **kw}

    def test_both_earlier_default_words_are_replaced_and_an_admins_are_kept(self):
        for old in (["accepted", "completed"], ["Completed", "accepted"], ["invoiced"]):
            self.assertEqual(status_mapping_for({"won": old, "lost": ["voided"]}), ({"won": ["job"], "lost": ["voided"]}, True))
        custom = {"won": ["accepted"], "lost": ["voided"]}
        self.assertEqual(status_mapping_for(custom), (custom, False))

    def test_a_job_reopened_by_the_invoice_rule_is_won_again_on_its_job_date_and_in_the_pipeline(self):
        deal = self.deal(sourceData={"status": "ACCEPTED", **job("2373")})
        target = reclassified(deal, MAPPING, "AUD")
        self.assertEqual(target, {"dealStatus": "won", "stageId": hoops.IN_PRODUCTION, "expectedClosingDate": "2026-11-02", "inPipeline": True})
        op = _update_for(deal, target)
        # A change of rule, not of the sale: no activity fields are touched, and no closing moment is invented.
        self.assertNotIn("lastActivityAt", op._doc["$set"])
        self.assertNotIn("closedAt", op._doc["$set"])

    def test_an_accepted_quote_without_a_job_reopens_and_loses_its_closing_moment_only(self):
        deal = self.deal(dealStatus="won", stageId="Invoiced", closedAt=datetime(2026, 11, 2), sourceData={"status": "ACCEPTED", "accepted": True})
        target = reclassified(deal, MAPPING, "AUD")
        self.assertEqual(target["dealStatus"], "open")
        self.assertFalse(target["inPipeline"])
        self.assertEqual(_update_for(deal, target)._doc["$unset"], {"closedAt": ""})

    def test_nothing_is_written_when_nothing_changes(self):
        deal = self.deal(dealStatus="won", stageId=hoops.IN_PRODUCTION, expectedClosingDate="2026-11-02", inPipeline=True, sourceData=job("2373"))
        self.assertIsNone(_update_for(deal, reclassified(deal, MAPPING, "AUD")))

    def test_a_lost_sale_without_its_voided_date_keeps_the_stored_date(self):
        deal = self.deal(dealStatus="lost", stageId="Lost", expectedClosingDate="2026-05-01", sourceData={"status": "LOST"})
        self.assertEqual(reclassified(deal, MAPPING, "AUD")["expectedClosingDate"], "2026-05-01")

    def test_a_deal_with_no_kept_transaction_is_left_alone(self):
        self.assertIsNone(reclassified(self.deal(sourceData=None), MAPPING, "AUD"))


if __name__ == "__main__":
    unittest.main()
