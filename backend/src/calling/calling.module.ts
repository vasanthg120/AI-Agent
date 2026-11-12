import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { CallCopilotModule } from '../call-copilot/call-copilot.module';
import { CallSession, CallSessionSchema } from '../call-copilot/schemas/call-session.schema';
import { Deal, DealSchema } from '../crm/schemas/deal.schema';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { PlivoModule } from '../plivo/plivo.module';
import { TwilioModule } from '../twilio/twilio.module';
import { CallingController } from './calling.controller';
import { CallingService } from './calling.service';

// Phone calls regardless of carrier: Plivo for domestic (Indian) numbers,
// Twilio for international ones — one call button, one call log. The log reads
// each call's report (its Call Copilot session) and deal name, and Contacts
// searches the Customers directory.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CallSession.name, schema: CallSessionSchema },
      { name: Deal.name, schema: DealSchema },
    ]),
    // Only the "can Plivo reach us?" check — a few seconds at most.
    HttpModule.register({ timeout: 5_000 }),
    AuthModule,
    PlivoModule,
    TwilioModule,
    CustomerIntelligenceModule,
    // "Try again" on a call whose transcription failed reprocesses the saved recording.
    CallCopilotModule,
  ],
  controllers: [CallingController],
  providers: [CallingService],
})
export class CallingModule {}





//test