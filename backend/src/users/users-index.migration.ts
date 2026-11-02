import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

// Moves the users collection from "every email is unique" to "every LOGIN's email
// is unique", so a member record can show the person's real address (see
// User.linkedLoginUserId). Runs at every startup and does nothing once done.
//
// The order keeps uniqueness enforced throughout: every existing account is marked
// as a login first, the new unique index is built while the old one still exists,
// and only then is the old one dropped. No business data moves.
@Injectable()
export class UsersIndexMigration implements OnModuleInit {
  private readonly logger = new Logger(UsersIndexMigration.name);

  constructor(@InjectConnection() private connection: Connection) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      // Sign-in keeps working on the old index; only creating member records
      // fails until this succeeds, so the app should still come up.
      this.logger.error(`Users index migration did not finish: ${(err as Error).message}`);
    }
  }

  async run(): Promise<void> {
    const users = this.connection.collection('users');
    const existing: { name?: string }[] = await users.indexes().catch(() => []);
    const has = (name: string) => existing.some((index) => index.name === name);

    const marked = await users.updateMany({ isLogin: { $exists: false } }, { $set: { isLogin: true } });
    if (!has('email_login_unique')) {
      await users.createIndex({ email: 1 }, { name: 'email_login_unique', unique: true, partialFilterExpression: { isLogin: true } });
    }
    if (!has('email_lookup')) {
      await users.createIndex({ email: 1 }, { name: 'email_lookup' });
    }
    if (has('email_1')) {
      const [userCount, orgCount] = await Promise.all([users.countDocuments(), this.connection.collection('organizations').countDocuments()]);
      await users.dropIndex('email_1');
      this.logger.log(`Email index moved to login accounts only (${marked.modifiedCount} accounts marked; ${userCount} users and ${orgCount} organizations unchanged).`);
    }
  }
}
