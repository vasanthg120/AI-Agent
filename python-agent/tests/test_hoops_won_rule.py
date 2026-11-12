"""How Hoops sales are read (user, 2026-11-11/12, from Hoops' own jobs report):
- WON when a job is created (November: only job #2373, Sydney Children's
  Hospital Randwick Nutrition and Dietitian department), dated by the job in
  the business's own time zone;
- every quote CREATED BUT NOT WON is open — that is the pipeline: sent, at a
  follow-up step, on hold, a draft, or accepted with no job yet;
- voided or lost: lost.
Also the one-time re-classification of the sales already stored
(hoops_won_rule.py), which must change no more than the rule: no activity, no
lastActivityAt, admin-edited status words kept — and which removes the
short-lived `inPipeline` flag ("pipeline = jobs in progress", corrected by the
user: those are won sales).

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


class WonAndPipelineTests(unittest.TestCase):
    def test_a_new_job_is_won_on_the_day_the_job_was_created(self):
        f = fields(status="ACCEPTED", accepted=True, acceptedAt="2026-11-01T22:00:00Z", number="4397", **job())
        self.assertEqual(map_status(f["_status"], MAPPING), "won")
        self.assertEqual(f["_closeDate"], "2026-11-02")  # the job's date, not the acceptance
        self.assertEqual(f["_stage"], hoops.IN_PRODUCTION)
        self.assertNotIn("_inPipeline", f)  # a won job is not pipeline

    def test_a_paid_or_completed_job_is_still_simply_won(self):
        paid = fields(status="Paid In square", invoice={"balance": 0}, **job("2124", "2026-06-20T00:00:00Z"))
        done = fields(status="ACCEPTED", completed=True, **job("2008", "2026-04-01T00:00:00Z", completed=True))
        self.assertEqual(map_status(paid["_status"], MAPPING), "won")
        self.assertEqual(map_status(done["_status"], MAPPING), "won")
        self.assertEqual(done["_stage"], "Completed")

    def test_every_quote_created_but_not_won_is_open_the_pipeline(self):
        for status in ("SENT", "FOLLOW UP 1", "FOLLOW UP 3", "ON HOLD", "QUOTING OPTIONS", "Provide Samples!", "PRE QUOTATION", "CREATED"):
            f = fields(status=status)
            self.assertEqual(map_status(f["_status"], MAPPING), "open", status)

    def test_an_accepted_quote_with_no_job_yet_is_open_not_won(self):
        f = fields(status="ACCEPTED", accepted=True, acceptedAt="2026-11-02T00:00:00Z")
        self.assertEqual(map_status(f["_status"], MAPPING), "open")
        self.assertEqual(f["_stage"], hoops.ACCEPTED_NO_JOB)
        self.assertEqual(f["_quoteStatus"], "accepted")  # the quotation itself was still accepted
        # Open quotes are expected 30 days after creation when Hoops has no deadline.
        self.assertEqual(f["_closeDate"], "2026-10-21")

    def test_voided_or_lost_is_lost(self):
        self.assertEqual(map_status(fields(status="ACCEPTED", voided=True, **job("2358"))["_status"], MAPPING), "lost")
        self.assertEqual(map_status(fields(status="LOST")["_status"], MAPPING), "lost")

    def test_a_job_whose_only_job_is_voided_does_not_count(self):
        row = job("2302")
        row["jobs"][0]["voided"] = True
        self.assertNotEqual(map_status(fields(status="FOLLOW UP 3", **row)["_status"], MAPPING), "won")

    def test_an_invoice_alone_is_not_the_sale_the_job_is(self):
        f = fields(status="SENT", invoice={"totalAmount": 100, "transactionDate": "2026-06-01T00:00:00Z"})
        self.assertEqual(map_status(f["_status"], MAPPING), "open")

    def test_a_won_sale_is_never_dated_by_its_last_edit(self):
        f = fields(status="ACCEPTED", jobNumber="1700", updatedAt="2026-11-03T09:00:00Z", createdAt="2025-03-17T01:00:00Z")
        self.assertEqual(f["_closeDate"], "2025-03-17")

    def test_the_day_is_the_businesss_own_not_utcs(self):
        # Job #2315 was created at 9:32am on 1 September in Sydney — still 31 August in UTC.
        row = {"status": "ACCEPTED", **job("2315", "2026-08-31T23:32:00Z")}
        self.assertEqual(fields(**row)["_closeDate"], "2026-08-31")  # no zone given: UTC, as before
        sydney = hoops.transaction_fields({"_id": "t1", **row}, "AUD", ZoneInfo("Australia/Sydney"))
        self.assertEqual(sydney["_closeDate"], "2026-09-01")


class OneTimeReclassificationTests(unittest.TestCase):
    def deal(self, **kw):
        base = {
            "_id": "d1",
            "externalId": "t1",
            "createdAt": datetime(2026, 9, 21, 3, 15),
            "dealStatus": "open",
            "stageId": "Sent",
            "expectedClosingDate": "2026-10-21",
            "lastActivityAt": datetime(2026, 11, 2),
        }
        return {**base, **kw}

    def test_every_earlier_default_word_is_replaced_and_an_admins_are_kept(self):
        for old in (["accepted", "completed"], ["Completed", "accepted"], ["invoiced"]):
            self.assertEqual(status_mapping_for({"won": old, "lost": ["voided"]}), ({"won": ["job"], "lost": ["voided"]}, True))
        custom = {"won": ["accepted"], "lost": ["voided"]}
        self.assertEqual(status_mapping_for(custom), (custom, False))

    def test_the_work_in_progress_flag_is_removed_and_nothing_else_moves(self):
        deal = self.deal(dealStatus="won", stageId=hoops.IN_PRODUCTION, expectedClosingDate="2026-11-02", inPipeline=True, sourceData=job("2373"))
        op = _update_for(deal, reclassified(deal, MAPPING, "AUD"))
        self.assertEqual(op._doc, {"$unset": {"inPipeline": ""}})

    def test_a_reopened_job_is_won_again_on_its_job_date_without_activity(self):
        deal = self.deal(stageId="Accepted – not invoiced", sourceData={"status": "ACCEPTED", **job("2373")})
        target = reclassified(deal, MAPPING, "AUD")
        self.assertEqual(target, {"dealStatus": "won", "stageId": hoops.IN_PRODUCTION, "expectedClosingDate": "2026-11-02"})
        op = _update_for(deal, target)
        # A change of rule, not of the sale: no activity fields are touched, and no closing moment is invented.
        self.assertNotIn("lastActivityAt", op._doc["$set"])
        self.assertNotIn("closedAt", op._doc["$set"])

    def test_an_accepted_quote_without_a_job_reopens_and_loses_its_closing_moment_only(self):
        deal = self.deal(dealStatus="won", stageId="Invoiced", closedAt=datetime(2026, 11, 2), sourceData={"status": "ACCEPTED", "accepted": True})
        target = reclassified(deal, MAPPING, "AUD")
        self.assertEqual(target["dealStatus"], "open")
        self.assertEqual(_update_for(deal, target)._doc["$unset"], {"closedAt": ""})

    def test_nothing_is_written_when_nothing_changes(self):
        deal = self.deal(dealStatus="won", stageId=hoops.IN_PRODUCTION, expectedClosingDate="2026-11-02", sourceData=job("2373"))
        self.assertIsNone(_update_for(deal, reclassified(deal, MAPPING, "AUD")))

    def test_a_lost_sale_without_its_voided_date_keeps_the_stored_date(self):
        deal = self.deal(dealStatus="lost", stageId="Lost", expectedClosingDate="2026-05-01", sourceData={"status": "LOST"})
        self.assertEqual(reclassified(deal, MAPPING, "AUD")["expectedClosingDate"], "2026-05-01")

    def test_a_deal_with_no_kept_transaction_is_left_alone(self):
        self.assertIsNone(reclassified(self.deal(sourceData=None), MAPPING, "AUD"))


if __name__ == "__main__":
    unittest.main()
