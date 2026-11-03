import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { buildManifestCredentials, resolveManifestAuthType } from './connector-manifest.util';
import { CreateEndpointDto } from './dto/create-endpoint.dto';
import { CreateResourceDto } from './dto/create-resource.dto';
import { ExecuteEndpointDto } from './dto/execute-endpoint.dto';
import { ImportConnectorManifestDto } from './dto/import-connector-manifest.dto';
import { DynamicExecutorService } from './dynamic-executor.service';
import { IntegrationResourcesService } from './integration-resources.service';
import { IntegrationsService } from './integrations.service';
import { Permission } from '../common/permissions/permission.decorator';

// Metadata CRUD for the "unlimited resources/endpoints per integration"
// engine (see integration-resource.schema.ts / integration-endpoint.schema.ts),
// plus the two routes that make it actually usable: /capabilities
// (discovery — what's configured) and /execute (the generic Dynamic
// Executor — run any configured endpoint). Registered alongside
// IntegrationsController under the same 'integrations' base path.
@UseGuards(JwtAuthGuard)
@Permission('integrations')
@Controller('integrations')
export class ResourcesController {
  constructor(
    private resourcesService: IntegrationResourcesService,
    private executor: DynamicExecutorService,
    private integrationsService: IntegrationsService,
  ) {}

  // Bulk connector import — pastes a whole manifest (base URL + auth
  // template + modules[].actions[]) and creates the credential plus every
  // resource/endpoint in one call, instead of the one-at-a-time Add
  // Integration + per-endpoint builder flow below. Admin-only, matching
  // every other integration-mutating route on this controller.
  @Post('import-connector')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async importConnector(@CurrentUser() user: JwtPayload, @Body() dto: ImportConnectorManifestDto) {
    const provider = dto.connector_id.trim().toLowerCase();
    const authType = resolveManifestAuthType(dto.auth);
    const credentials = buildManifestCredentials(authType, dto.auth, {
      apiKeyValue: dto.apiKeyValue,
      username: dto.username,
      password: dto.password,
    });

    await this.integrationsService.connectWithAuth(user.organizationId, provider, {
      authType,
      credentials: credentials as unknown as Record<string, unknown>,
      baseUrl: dto.base_url,
    });

    const { resourcesCreated, endpointsCreated } = await this.resourcesService.importManifestModules(
      user.organizationId,
      provider,
      dto.modules,
    );

    return { provider, authType, resourcesCreated, endpointsCreated };
  }

  // Read-only discovery — what's connected and what actions are configured
  // for it. Used by the AI's integration_capabilities tool (via
  // python-agent's HTTP bridge) and by the frontend builder UI. No admin
  // restriction: any authenticated org member (and python-agent's service
  // token) can see what's available, same as the existing GET /integrations.
  @Get('capabilities')
  listCapabilities(@CurrentUser() user: JwtPayload, @Query('provider') provider?: string) {
    return this.resourcesService.listCapabilities(user.organizationId, provider);
  }

  // The Dynamic Executor entry point — one generic route for every
  // provider/resource/endpoint combination, reached from the browser
  // (testing from the builder UI) and from python-agent's
  // integration_execute tool via its service-JWT bridge. Deliberately
  // JwtAuthGuard-only (no @Roles), matching crm.controller.ts's pattern,
  // since both regular users and the service token need to call it.
  @Post('execute')
  execute(@CurrentUser() user: JwtPayload, @Body() dto: ExecuteEndpointDto) {
    return this.executor.execute(user.organizationId, dto.provider, dto.resourceKey, dto.endpointKey, {
      pathParams: dto.pathParams,
      query: dto.query,
      body: dto.body,
    });
  }

  @Get(':provider/resources')
  listResources(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.resourcesService.listResources(user.organizationId, provider);
  }

  @Post(':provider/resources')
  @UseGuards(RolesGuard)
  @Roles('admin')
  createResource(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Body() dto: CreateResourceDto,
  ) {
    return this.resourcesService.createResource(user.organizationId, provider, dto);
  }

  @Delete(':provider/resources/:resourceKey')
  @UseGuards(RolesGuard)
  @Roles('admin')
  deleteResource(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Param('resourceKey') resourceKey: string,
  ) {
    return this.resourcesService.deleteResource(user.organizationId, provider, resourceKey);
  }

  @Get(':provider/resources/:resourceKey/endpoints')
  listEndpoints(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Param('resourceKey') resourceKey: string,
  ) {
    return this.resourcesService.listEndpoints(user.organizationId, provider, resourceKey);
  }

  @Post(':provider/resources/:resourceKey/endpoints')
  @UseGuards(RolesGuard)
  @Roles('admin')
  createEndpoint(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Param('resourceKey') resourceKey: string,
    @Body() dto: CreateEndpointDto,
  ) {
    return this.resourcesService.createEndpoint(user.organizationId, provider, resourceKey, dto);
  }

  @Delete(':provider/resources/:resourceKey/endpoints/:endpointKey')
  @UseGuards(RolesGuard)
  @Roles('admin')
  deleteEndpoint(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Param('resourceKey') resourceKey: string,
    @Param('endpointKey') endpointKey: string,
  ) {
    return this.resourcesService.deleteEndpoint(user.organizationId, provider, resourceKey, endpointKey);
  }

  // Per-endpoint "Test" button in the builder UI — just the Dynamic
  // Executor itself, with whatever sample pathParams/query/body the admin
  // supplies while configuring it.
  @Post(':provider/resources/:resourceKey/endpoints/:endpointKey/test')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async testEndpoint(
    @CurrentUser() user: JwtPayload,
    @Param('provider') provider: string,
    @Param('resourceKey') resourceKey: string,
    @Param('endpointKey') endpointKey: string,
    @Body() body: { pathParams?: Record<string, string>; query?: Record<string, string>; body?: unknown },
  ) {
    const result = await this.executor.execute(user.organizationId, provider, resourceKey, endpointKey, body);
    return { ok: result.success, message: result.message, statusCode: result.statusCode, data: result.data };
  }
}
