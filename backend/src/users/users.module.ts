import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentRole, AgentRoleSchema } from '../agent-roles/schemas/agent-role.schema';
import { User, UserSchema } from './schemas/user.schema';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      // Independent local registration (not imported from AgentRolesModule)
      // — same pattern ChatModule already uses for this collection, avoids
      // a circular dependency (AuthModule -> UsersModule, ChatModule ->
      // AuthModule, so UsersModule -> ChatModule would close the cycle).
      { name: AgentRole.name, schema: AgentRoleSchema },
    ]),
  ],
  // Cross-org platform_admin management moved to auth/admin-accounts.controller.ts
  // — admin accounts are a separate credential now (see AdminAccount schema),
  // not a role tag on a User. UsersController stays strictly org-scoped.
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
