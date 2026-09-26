import { ForbiddenException } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';

// Provider/model-availability control, not an AI on/off switch — a user
// blocked from voice still has full text-chat access via ChatController,
// which never reads this field. Checked BEFORE any call into the voice
// services (which is what actually reaches python-agent/the TTS providers),
// so a blocked request never makes a provider call, never reserves credits,
// and never deducts anything. user.voiceAccessEnabled is undefined only for
// special-purpose tokens (2FA challenge, OAuth state) that can't reach these
// routes anyway (JwtAuthGuard rejects them first); for every real
// session/API-token request it's always a live boolean refreshed from the
// User document on this exact request (see JwtStrategy.validate()).
export function assertVoiceAllowed(user: JwtPayload): void {
  if (user.voiceAccessEnabled === false) {
    throw new ForbiddenException('Voice access has been disabled for your account by an administrator.');
  }
}
