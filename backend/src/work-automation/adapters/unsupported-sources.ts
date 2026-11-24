// Sources people ask for that cannot honestly be offered today, and exactly why.
// Shown on the admin page so nobody assumes they are collecting from them.
export const UNSUPPORTED_SOURCES: { id: string; label: string; reason: string }[] = [
  {
    id: 'gorilladash',
    label: 'GorillaDash',
    reason:
      'The GorillaDash API Haive is connected to exposes enquiries, people, enquiry forms, locations, reviews and content (knowledge, blog, menu, media). It has no tasks, activities or follow-ups, and its enquiries carry no assignee or status field, so nothing is assigned to an employee there. Enquiries already reach Haive as CRM deals.',
  },
  {
    id: 'google_calendar',
    label: 'Google Calendar',
    reason:
      'Haive\'s Google connections do not include Calendar: Gmail is connected with gmail.readonly and gmail.send, and Google Drive with Drive scopes only. Reading Google Calendar needs a separate consent (calendar.readonly) that no employee has granted. Outlook Calendar is read for each report\'s meetings list.',
  },
];
