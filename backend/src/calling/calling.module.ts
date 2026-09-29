import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlivoModule } from '../plivo/plivo.module';
import { TwilioModule } from '../twilio/twilio.module';
import { CallingController } from './calling.controller';
import { CallingService } from './calling.service';

// Phone calls regardless of carrier: Plivo for domestic (Indian) numbers,
// Twilio for international ones — one call button, one call log.
@Module({
  imports: [AuthModule, PlivoModule, TwilioModule],
  controllers: [CallingController],
  providers: [CallingService],
})
export class CallingModule {}
