import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { ApiToken, ApiTokenSchema } from './schemas/api-token.schema';

// @Global() (same trick EncryptionModule already uses) — JwtAuthGuard's PAT
// branch injects ApiTokensService directly, and JwtAuthGuard is used via
// @UseGuards() in nearly every controller in the app. Without this, every
// one of those modules would need to import ApiTokensModule just to satisfy
// the guard's own dependency, which defeats the "zero controller changes"
// point of putting the PAT branch inside the guard in the first place.
@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: ApiToken.name, schema: ApiTokenSchema }]), UsersModule, OrganizationsModule],
  controllers: [ApiTokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
