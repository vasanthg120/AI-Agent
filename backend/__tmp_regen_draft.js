const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const http = require('http');
require('dotenv').config();

(async () => {
  const client = await MongoClient.connect('mongodb://localhost:27017/agent');
  const db = client.db();
  const user = await db.collection('users').findOne({ email: 'abishake@pantheras.io' });
  const reminder = await db.collection('email_follow_up_reminders').findOne({ reminderType: 'sla_breach' });

  const jti = crypto.randomUUID();
  await db.collection('users').updateOne(
    { _id: user._id },
    { $push: { sessions: { jti, createdAt: new Date(), lastUsedAt: new Date(), userAgent: 'ai-followup-diagnostic', ip: '127.0.0.1' } } },
  );
  await client.close();

  const token = jwt.sign(
    { sub: user._id.toString(), email: user.email, roles: user.roles, organizationId: user.organizationId, storeId: user.storeId, jti },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );
  console.log('minted session jti:', jti);

  const body = JSON.stringify({});
  const req = http.request(
    {
      host: 'localhost',
      port: 3000,
      method: 'POST',
      path: `/email-intelligence/follow-ups/${reminder._id.toString()}/draft`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    },
    (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        console.log('status:', res.statusCode);
        console.log(data);
      });
    },
  );
  req.on('error', (e) => console.error('request error:', e.message));
  req.write(body);
  req.end();
})();
