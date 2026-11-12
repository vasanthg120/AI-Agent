import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { InvitationsService } from './invitations.service';
import { UsersService } from './users.service';
import { Permission, PermissionExempt } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('users')
@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private invitations: InvitationsService,
  ) {}

  @Get('me')
  @PermissionExempt('personal')
  async me(@CurrentUser() user: JwtPayload) {
    return this.usersService.profile(user.sub);
  }

  // Self-service profile edit — any signed-in user, only their own record,
  // only the fields UpdateProfileDto allows. Declared before PATCH :id so
  // "me" is never captured as an id by the admin-only route below.
  @Patch('me')
  @PermissionExempt('personal')
  updateMe(@CurrentUser() user: JwtPayload, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateOwnProfile(user.sub, dto);
  }

  // The modules, actions and groups a person's access is made of — the Users page
  // and the AI role editor draw their permission grids from this, so there is no
  // second copy of the list. Nothing in it is private to the business.
  @Get('permission-catalog')
  @PermissionExempt('personal')
  permissionCatalog() {
    return this.usersService.permissionCatalog();
  }

  // The active AI roles a person can be given, with the account type and starting
  // permissions each one brings. Part of User Management (not AI Roles), so whoever
  // may add people can see what to choose from.
  @Get('ai-roles')
  @UseGuards(RolesGuard)
  @Roles('admin')
  aiRoles(@CurrentUser() caller: JwtPayload) {
    return this.usersService.assignableAiRoles(caller.organizationId);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles('admin')
  list(@CurrentUser() caller: JwtPayload) {
    return this.usersService.listDescribed(caller.organizationId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  async create(@CurrentUser() caller: JwtPayload, @Body() dto: CreateUserDto) {
    const created = await this.usersService.createByAdmin(dto, caller.organizationId, caller);
    if (!dto.sendInvite) return created;
    // Whether the email actually went is passed on, so the screen never says "sent" for one that wasn't.
    const { activationLink, emailSent, emailProblem } = await this.invitations.inviteById(created.user.id, caller.organizationId);
    // `created.user` was described before the invitation existed; it is pending now.
    return { ...created, user: { ...created.user, pendingInvitation: true }, activationLink, emailSent, emailProblem };
  }

  @Post(':id/resend-invitation')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async resendInvitation(@CurrentUser() caller: JwtPayload, @Param('id') id: string) {
    await this.usersService.assertMayManage(caller, id, caller.organizationId);
    const { activationLink, emailSent, emailProblem } = await this.invitations.inviteById(id, caller.organizationId);
    return { activationLink, emailSent, emailProblem };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  update(@CurrentUser() caller: JwtPayload, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    if (id === caller.sub && (dto.active === false || (dto.role && dto.role !== 'admin'))) {
      throw new BadRequestException("Can't demote or disable your own account");
    }
    return this.usersService.updateByAdmin(id, dto, caller.organizationId, caller.sub, caller);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  remove(@CurrentUser() caller: JwtPayload, @Param('id') id: string) {
    if (id === caller.sub) {
      throw new BadRequestException("Can't delete your own account");
    }
    return this.usersService.deleteByAdmin(id, caller.organizationId, caller);
  }
}
