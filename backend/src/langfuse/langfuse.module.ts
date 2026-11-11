import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LangfuseAdminController } from './langfuse-admin.controller';
import { LangfuseConfigService } from './langfuse-config.service';
import { LangfuseConfig, LangfuseConfigSchema } from './schemas/langfuse-config.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: LangfuseConfig.name, schema: LangfuseConfigSchema }]), HttpModule.register({ timeout: 10_000 })],
  controllers: [LangfuseAdminController],
  providers: [LangfuseConfigService],
})
export class LangfuseModule {}
