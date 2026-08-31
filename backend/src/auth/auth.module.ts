import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { TwoFactorController } from './two-factor.controller';
import { TwoFactorService } from './two-factor.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { AdminAccount, AdminAccountSchema } from './schemas/admin-account.schema';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminAuthService } from './admin-auth.service';

@Module({
  imports: [
    UsersModule,
    OrganizationsModule,
    AuditModule,
    MongooseModule.forFeature([{ name: AdminAccount.name, schema: AdminAccountSchema }]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    HttpModule.register({ timeout: 15_000 }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: { expiresIn: config.get<string>('jwt.expiresIn') },
      }),
    }),
  ],
  controllers: [AuthController, OAuthController, TwoFactorController, AdminAuthController, AdminAccountsController],
  providers: [AuthService, JwtStrategy, OAuthService, TwoFactorService, AdminJwtStrategy, AdminAuthService],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
