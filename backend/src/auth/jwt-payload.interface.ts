export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
  organizationId: string;
  storeId?: string;
  assignedAgentId?: string;
  department?: string;
  // Provider/model-availability control, NOT an AI on/off switch — chat
  // (Anthropic) stays automatically available regardless of this field; it
  // only gates the separate voice (Sarvam) route. Refreshed from the live
  // User document on every request (see JwtStrategy.validate() and
  // ApiTokensService.authenticateToken()), never trusted from the token
  // itself, so an admin's change takes effect immediately without
  // requiring re-login. Optional because older special-purpose tokens
  // (2FA challenge, OAuth state) never carry it.
  voiceAccessEnabled?: boolean;
  // Present on real session-backed access tokens (see AuthService.issueSessionToken)
  // — matched against User.sessions in JwtStrategy.validate() so a revoked
  // session is rejected on its very next request. Absent on API-token-authenticated
  // requests (see JwtAuthGuard's PAT branch) and on special-purpose tokens.
  jti?: string;
  // Set by JwtStrategy.validate() ('session') and by JwtAuthGuard's PAT
  // branch ('api_token') — never set by the client, never trusted from an
  // incoming token. Consumed by RequireSessionAuthGuard to block API tokens
  // from managing security settings.
  authMethod?: 'session' | 'api_token' | 'service';
  // Only ever set on special-purpose, non-access tokens (the login-2FA
  // challenge token, OAuth's own `state` token) — never a real access
  // token. JwtStrategy.validate() rejects any incoming bearer token where
  // this is set, so a leaked challenge token can never be used as a real
  // Bearer credential even though it carries a valid `sub`.
  purpose?: string;
}
