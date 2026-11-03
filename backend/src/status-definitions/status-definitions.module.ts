import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { StatusDefinitionsController } from './status-definitions.controller';
import { StatusDefinitionsService } from './status-definitions.service';
import { StatusDefinition, StatusDefinitionSchema } from './schemas/status-definition.schema';

// Leaf module (only AuthModule) so any future board/analytics module can
// import it with no cycle risk — same shape as VendorsModule.
@Module({
  imports: [AuthModule, MongooseModule.forFeature([{ name: StatusDefinition.name, schema: StatusDefinitionSchema }])],
  controllers: [StatusDefinitionsController],
  providers: [StatusDefinitionsService],
  exports: [StatusDefinitionsService],
})
export class StatusDefinitionsModule {}
