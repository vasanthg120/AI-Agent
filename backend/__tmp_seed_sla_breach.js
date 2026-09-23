const { MongoClient, ObjectId } = require('mongodb');

(async () => {
  const client = await MongoClient.connect('mongodb://localhost:27017/agent');
  const db = client.db();

  const user = await db.collection('users').findOne({ email: 'abishake@pantheras.io' });
  if (!user) throw new Error('test user not found');

  const now = new Date();
  const emailItem = await db.collection('email_intelligence_items').insertOne({
    organizationId: user.organizationId,
    userId: user._id.toString(),
    mailboxEmail: 'enquiry.tnagar@fullypromoted.in',
    externalMessageId: `test-msg-${now.getTime()}`,
    receivedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
    subject: 'Quotation QUOTE111 - still valid?',
    fromAddress: 'john.smith@example.com',
    toAddresses: ['enquiry.tnagar@fullypromoted.in'],
    bodyPreview: 'Hi, can you confirm whether quotation QUOTE111 is still valid? We would like to finalize the order this week. Thanks, John',
    isRead: true,
    importance: 'normal',
    matchConfidence: 'none',
    intent: 'quotation_request',
    priority: 'high',
    urgency: 'high',
    sentiment: 'neutral',
    recommendedAction: 'Confirm quote validity',
    shouldDraft: true,
    aiStatus: 'draft_ready',
    status: 'pending',
    wasEdited: false,
    regeneratedCount: 0,
    missingFields: [],
    inconsistencyNotes: [],
    createdAt: now,
    updatedAt: now,
  });
  console.log('Created test email item:', emailItem.insertedId.toString());

  const slaRecord = await db.collection('email_sla_records').insertOne({
    organizationId: user.organizationId,
    emailId: emailItem.insertedId.toString(),
    assignedUserId: user._id.toString(),
    receivedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
    slaStartedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
    slaDueAt: new Date(now.getTime() - 60 * 60 * 1000), // 1 hour ago -> already overdue
    status: 'BREACHED',
    priority: 'high',
    isBreached: true,
    breachedAt: new Date(now.getTime() - 60 * 60 * 1000),
    escalationLevel: 0,
    businessHoursApplied: true,
    createdAt: now,
    updatedAt: now,
  });
  console.log('Created test SLA record (BREACHED):', slaRecord.insertedId.toString());

  console.log(JSON.stringify({
    organizationId: user.organizationId,
    userId: user._id.toString(),
    emailItemId: emailItem.insertedId.toString(),
    slaRecordId: slaRecord.insertedId.toString(),
  }));

  await client.close();
})();
