import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { StatusDefinitionsService } from './status-definitions.service';
import { UpdateStatusDefinitionDto } from './dto/update-status-definition.dto';

// Phase 2a of the Hoops-parity plan. Listing is open to any authenticated
// org member (@Roles omitted — JwtAuthGuard alone) since any role viewing a
// board needs to render a status's label/color, same reasoning
// resources.controller.ts's GET /integrations/capabilities already uses.
// Relabeling is an admin configuration action ("Edit Statuses" in the
// Hoops reference), gated the same way every other admin-config route in
// this codebase is (Deal Assignment, Integrations app-credentials, ...).
@UseGuards(JwtAuthGuard)
@Controller('status-definitions')
export class StatusDefinitionsController {
  constructor(private statusDefinitionsService: StatusDefinitionsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('field') field: string) {
    return this.statusDefinitionsService.list(user.organizationId, field);
  }

  @Patch(':field/:key')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  relabel(
    @CurrentUser() user: JwtPayload,
    @Param('field') field: string,
    @Param('key') key: string,
    @Body() dto: UpdateStatusDefinitionDto,
  ) {
    return this.statusDefinitionsService.relabel(user.organizationId, field, key, dto);
  }
}
