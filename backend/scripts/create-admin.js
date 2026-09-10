// One-off bootstrap for the very first platform admin account.
//
// Why this exists: AdminAccountsController.create() (POST /auth/admin/accounts)
// is gated behind AdminJwtAuthGuard — you must already be logged in as an admin
// to create one. With zero rows in `platform_admins`, that's a chicken-and-egg
// problem: POST /auth/admin/login always returns 401 "Invalid credentials"
// because no account exists to match against, and there's no in-app way to
// create the first one. This script inserts a `platform_admins` document
// directly, using the exact same hashing (bcrypt, 10 salt rounds) and shape
// AdminAuthService.create()/login() expect, so the result is a normal admin
// account the login endpoint accepts.
//
// Usage (from backend/):
//   node scripts/create-admin.js <email> <password> ["Display Name"]
// or:
//   npm run create-admin -- <email> <password> ["Display Name"]

const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
require('dotenv').config();

const SALT_ROUNDS = 10;

async function main() {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js <email> <password> ["Display Name"]');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/agent';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.collection('platform_admins').findOne({ email: normalizedEmail });
  if (existing) {
    console.error(`An admin account with email "${normalizedEmail}" already exists (id=${existing._id}).`);
    await client.close();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const now = new Date();
  const result = await db.collection('platform_admins').insertOne({
    email: normalizedEmail,
    passwordHash,
    name: name || 'Admin',
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  console.log(`Admin account created: id=${result.insertedId} email=${normalizedEmail}`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
