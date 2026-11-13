import unittest

from app.integrations.gorilladash import display_name
from app.integrations.gorilladash_names import name_for

ENQUIRY = {
    "id": 1915330,
    "enquiry_form": {"name": "Inquiry Form"},
    "person": {"business_name": "Galaxy Cast Tech", "email": "karthik@gmail.com", "first_name": "Karthik", "last_name": "Kannappan"},
    "fields": [{"name": "Message", "value": "200 polos"}, {"name": "Business Name", "value": "Galaxy Cast Tech"}],
}


class GorillaDashNamesTest(unittest.TestCase):
    """An enquiry is named from the person it carries (it was "Untitled deal")."""

    def test_enquiry_named_from_its_person(self):
        self.assertEqual(display_name(ENQUIRY), "Karthik Kannappan (Galaxy Cast Tech)")

    def test_business_from_the_form_when_the_person_has_none(self):
        enquiry = {**ENQUIRY, "person": {"first_name": "Karthik", "last_name": "", "email": "k@x.com"}}
        self.assertEqual(display_name(enquiry), "Karthik (Galaxy Cast Tech)")

    def test_email_then_the_form_name_as_last_resorts(self):
        self.assertEqual(display_name({"person": {"email": "k@x.com"}}), "k@x.com")
        self.assertEqual(display_name({"enquiry_form": {"name": "Inquiry Form"}, "person": {}}), "Inquiry Form enquiry")

    def test_a_person_record_still_named_as_before(self):
        self.assertEqual(display_name({"first_name": "Priya", "last_name": "Sharma", "business_name": "Acme"}), "Priya Sharma (Acme)")
        self.assertEqual(display_name({"business_name": "Acme"}), "Acme")

    def test_same_person_and_business_said_once(self):
        self.assertEqual(display_name({"person": {"first_name": "TEST", "business_name": "test"}}), "TEST")

    def test_repair_reads_the_stored_copy(self):
        self.assertEqual(name_for(ENQUIRY), "Karthik Kannappan (Galaxy Cast Tech)")
        self.assertIsNone(name_for(None))


if __name__ == "__main__":
    unittest.main()
