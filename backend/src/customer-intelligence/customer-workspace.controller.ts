import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Feature } from '../common/app-features';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CustomerWorkspaceService } from './customer-workspace.service';
import { CreateCustomerNoteDto, CreateCustomerTaskDto, SetCustomerStatusDto, UpdateCustomerTaskDto } from './dto/customer-workspace.dto';

// What the team attaches to a customer — comments, tasks, files — from the
// Customers panel. Same audience as the page itself; every call is scoped to
// the caller's organization and to that one customer, and every mutating call
// is recorded by the global AuditInterceptor.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('inquiries')
@Controller('customers')
export class CustomerWorkspaceController {
  constructor(private workspace: CustomerWorkspaceService) {}

  @Get(':id/workspace')
  overview(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.workspace.overview(user, id);
  }

  @Post(':id/notes')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addNote(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: CreateCustomerNoteDto) {
    return this.workspace.addNote(user, id, dto.body);
  }

  @Delete(':id/notes/:noteId')
  async removeNote(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('noteId') noteId: string) {
    await this.workspace.removeNote(user, id, noteId);
    return { status: 'ok' };
  }

  @Post(':id/tasks')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addTask(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: CreateCustomerTaskDto) {
    return this.workspace.addTask(user, id, dto);
  }

  @Patch(':id/tasks/:taskId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  updateTask(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('taskId') taskId: string, @Body() dto: UpdateCustomerTaskDto) {
    return this.workspace.updateTask(user, id, taskId, dto);
  }

  @Delete(':id/tasks/:taskId')
  async removeTask(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('taskId') taskId: string) {
    await this.workspace.removeTask(user, id, taskId);
    return { status: 'ok' };
  }

  @Post(':id/files')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  addFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.workspace.addFile(user, id, file);
  }

  // Always a download, never shown in the page: whatever the file is, the browser saves it rather than running it.
  @Get(':id/files/:fileId')
  async openFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const { stream, file } = await this.workspace.openFile(user, id, fileId);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    stream.pipe(res);
  }

  @Delete(':id/files/:fileId')
  async removeFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('fileId') fileId: string) {
    await this.workspace.removeFile(user, id, fileId);
    return { status: 'ok' };
  }

  // One of the six statuses, set by hand — or handed back to the connected systems (status null).
  @Patch(':id/status')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  setStatus(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetCustomerStatusDto) {
    return this.workspace.setStatus(user, id, dto.stage, dto.status ?? null);
  }
}
