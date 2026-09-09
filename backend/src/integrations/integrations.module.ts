import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { AdminIntegrationsController } from './admin-integrations.controller';
import { DynamicExecutorService } from './dynamic-executor.service';
import { IntegrationResourcesService } from './integration-resources.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { ResourcesController } from './resources.controller';
import {
  IntegrationCredential,
  IntegrationCredentialSchema,
} from './schemas/integration-credential.schema';
import { IntegrationEndpoint, IntegrationEndpointSchema } from './schemas/integration-endpoint.schema';
import { IntegrationResource, IntegrationResourceSchema } from './schemas/integration-resource.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IntegrationCredential.name, schema: IntegrationCredentialSchema },
      { name: IntegrationResource.name, schema: IntegrationResourceSchema },
      { name: IntegrationEndpoint.name, schema: IntegrationEndpointSchema },
    ]),
    // Test Connection (IntegrationsService.testConnection) and the Dynamic
    // Executor both make outbound requests to whatever base URL/endpoint
    // the customer has configured.
    HttpModule.register({ timeout: 15_000 }),
    AuthModule,
  ],
  controllers: [IntegrationsController, ResourcesController, AdminIntegrationsController],
  providers: [IntegrationsService, IntegrationResourcesService, DynamicExecutorService],
})
export class IntegrationsModule {}
