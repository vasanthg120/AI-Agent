import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { GmailController } from './gmail.controller';
import { GmailConnection, GmailConnectionSchema } from './schemas/gmail-connection.schema';
import { GmailService } from './gmail.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: GmailConnection.name, schema: GmailConnectionSchema }]),
    HttpModule.register({ timeout: 15_000 }),
    AuthModule,
    IntegrationsModule,
  ],
  controllers: [GmailController],
  providers: [GmailService],
})
export class GmailModule {}
