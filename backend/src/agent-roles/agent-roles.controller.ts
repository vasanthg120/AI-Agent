import { FileInterceptor } from '@nestjs/platform-express';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { AgentRolesService } from './agent-roles.service';
import { CreateAgentRoleDto } from './dto/create-agent-role.dto';
import { GenerateFromDescriptionDto } from './dto/generate-from-description.dto';
import { UpdateAgentRoleDto } from './dto/update-agent-role.dto';
import { holdsPermission, isPermissionManaged, Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('ai_roles')
@Controller('agent-roles')
export class AgentRolesController {
  constructor(private agentRolesService: AgentRolesService) {}

  // Read by the AI Roles settings and the Agent Builder (chat lists its agents
  // through /chat/agents). generate/update/remove below create or change the AI
  // personas every user interacts with, so those are admin-only, same as the
  // equally sensitive integrations/store-settings mutations — or, for someone
  // given AI Roles access, the actions they were given.
  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.agentRolesService.listAll(user.organizationId);
  }

  @Post('generate')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  generate(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return this.agentRolesService.generateDraft(user.sub, user.organizationId, bearerToken, file);
  }

  // Agent Builder Phase 1 — Describe method: same admin-only, draft-status
  // outcome as generate() above, just no file/Qdrant document involved.
  @Post('generate-from-description')
  @UseGuards(RolesGuard)
  @Roles('admin')
  generateFromDescription(@CurrentUser() user: JwtPayload, @Body() dto: GenerateFromDescriptionDto) {
    return this.agentRolesService.generateFromDescription(user.sub, user.organizationId, dto.description);
  }

  // Agent Builder Phase 1 — Manual and Template methods (Template is purely
  // a frontend concept, a preset payload posted here like any other manual
  // create). No AI call, no file.
  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateAgentRoleDto) {
    return this.agentRolesService.createManual(user.sub, user.organizationId, dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateAgentRoleDto, @Req() req: Request) {
    // Activating a role, or setting it back to draft, is its own permission.
    if (dto.status !== undefined && isPermissionManaged(user) && !holdsPermission(user, 'ai_roles', 'manage')) {
      throw new ForbiddenException('You don’t have permission to activate AI roles or set them back to draft. Ask an admin for access.');
    }
    const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return this.agentRolesService.update(id, dto, bearerToken, user.organizationId);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Req() req: Request) {
    const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return this.agentRolesService.remove(id, bearerToken, user.organizationId);
  }
}
