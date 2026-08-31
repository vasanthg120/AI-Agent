import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminAuditController } from './admin-audit.controller';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: AuditLog.name, schema: AuditLogSchema }])],
  controllers: [AuditController, AdminAuditController],
  providers: [
    AuditService,
    // Global interceptor via the APP_INTERCEPTOR token (not app.useGlobalInterceptors()
    // in main.ts) specifically so it goes through Nest's DI and can inject
    // AuditService — applies to every mutating route app-wide with zero
    // per-controller wiring, see AuditInterceptor for the method/route filter.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
