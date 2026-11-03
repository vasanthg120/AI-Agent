import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { UsersModule } from '../users/users.module';
import { AccountsController, SubAccountsController } from './sub-accounts.controller';
import { SubAccountsService } from './sub-accounts.service';
import { SubscriptionLockInterceptor } from './subscription-lock.interceptor';

@Module({
  imports: [
    AuthModule,
    ApiTokensModule,
    AuditModule,
    OrganizationsModule,
    UsersModule,
    MongooseModule.forFeature([{ name: Organization.name, schema: OrganizationSchema }]),
  ],
  controllers: [AccountsController, SubAccountsController],
  providers: [SubAccountsService, { provide: APP_INTERCEPTOR, useClass: SubscriptionLockInterceptor }],
})
export class SubAccountsModule {}
