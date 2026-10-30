import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { UsersModule } from '../users/users.module';
import { OutlookController } from './outlook.controller';
import { OutlookConnection, OutlookConnectionSchema } from './schemas/outlook-connection.schema';
import {
  MicrosoftTenantAuthorization,
  MicrosoftTenantAuthorizationSchema,
} from './schemas/microsoft-tenant-authorization.schema';
import { OutlookService } from './outlook.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OutlookConnection.name, schema: OutlookConnectionSchema },
      { name: MicrosoftTenantAuthorization.name, schema: MicrosoftTenantAuthorizationSchema },
    ]),
    HttpModule.register({ timeout: 15_000 }),
    AuthModule,
    // Needed for listOrgAccounts()'s owner name/email lookup (org-wide
    // account visibility) — unrelated to OAuth app credentials, kept.
    UsersModule,
    // resolveOAuthAppCredentials/saveOAuthAppCredentials — the platform
    // Azure App Registration's Client ID/Secret, same mechanism
    // GmailModule already uses for its own OAuth app.
    IntegrationsModule,
  ],
  controllers: [OutlookController],
  providers: [OutlookService],
})
export class OutlookModule {}
