import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentExecution, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { IntegrationCredential, IntegrationCredentialSchema } from '../integrations/schemas/integration-credential.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { AiUsageAdminController } from './ai-usage-admin.controller';
import { AiUsageAdminService } from './ai-usage-admin.service';

// Read-only reporting over agent_executions/integration_credentials — same
// collections CommandCenterModule/IntegrationsModule already own, registered
// again here via MongooseModule.forFeature (safe: Mongoose models are keyed
// by name+connection, not exclusive to one module) rather than importing
// those modules wholesale, since this only needs their models, not their
// services/controllers.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AgentExecution.name, schema: AgentExecutionSchema },
      { name: IntegrationCredential.name, schema: IntegrationCredentialSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [AiUsageAdminController],
  providers: [AiUsageAdminService],
})
export class AiUsageModule {}
