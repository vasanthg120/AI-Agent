import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    const found = await this.usersService.findById(user.sub);
    return found ? this.usersService.toPublic(found) : null;
  }

  // Self-service profile edit — any signed-in user, only their own record,
  // only the fields UpdateProfileDto allows. Declared before PATCH :id so
  // "me" is never captured as an id by the admin-only route below.
  @Patch('me')
  updateMe(@CurrentUser() user: JwtPayload, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateOwnProfile(user.sub, dto);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles('admin')
  async list(@CurrentUser() caller: JwtPayload) {
    const users = await this.usersService.findAll(caller.organizationId);
    return users.map((u) => this.usersService.toPublic(u));
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  create(@CurrentUser() caller: JwtPayload, @Body() dto: CreateUserDto) {
    return this.usersService.createByAdmin(dto, caller.organizationId);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  update(@CurrentUser() caller: JwtPayload, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    if (id === caller.sub && (dto.active === false || (dto.role && dto.role !== 'admin'))) {
      throw new BadRequestException("Can't demote or disable your own account");
    }
    return this.usersService.updateByAdmin(id, dto, caller.organizationId);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  remove(@CurrentUser() caller: JwtPayload, @Param('id') id: string) {
    if (id === caller.sub) {
      throw new BadRequestException("Can't delete your own account");
    }
    return this.usersService.deleteByAdmin(id, caller.organizationId);
  }
}
