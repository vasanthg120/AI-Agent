export interface JwtPayload {
  // The account acting. Normally the login itself; while someone is working in
  // another business it is their member record there (see loginUserId).
  sub: string;
  // Present only on a token for a member record: the login behind it, whose
  // sessions it lives under. See UsersService.resolveSession, which checks the
  // two are really linked on every request rather than trusting this claim.
  loginUserId?: string;
  // Set by JwtStrategy from the live organization, never read from the token:
  // only sub-accounts can be locked for having no subscription, so a Main Account
  // pays no extra lookup on any request (see SubscriptionLockInterceptor).
  isSubAccount?: boolean;
  // The token's own expiry, carried through by JwtStrategy so switching accounts
  // can keep it — moving between businesses never extends a session.
  exp?: number;
  email: string;
  roles: string[];
  organizationId: string;
  storeId?: string;
  assignedAgentId?: string;
  // For an account tied to an AI role: the app features that role includes
  // (see common/app-features.ts). Resolved from the database on every
  // request by JwtStrategy — never read from the token itself.
  features?: string[];
  // For a person created with their own page & action permissions
  // ("customers:edit", see common/permissions/app-modules.ts). Absent for owners,
  // admins and older accounts. Read from the database on every request, like
  // features — never from the token.
  permissions?: string[];
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
  // The organization-purchased-credits on/off switch for this employee (see
  // ChatController.assertAiAccessAllowed) — same refresh/trust rules as
  // voiceAccessEnabled above: re-read from the live User document on every
  // request, never trusted from the token itself, optional because older
  // special-purpose tokens never carry it.
  aiAccessEnabled?: boolean;
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

/** The login behind a request, whichever business it is working in. Anything about
 * the person rather than the business (password, 2FA, sessions) belongs to this. */
export function loginIdOf(user: Pick<JwtPayload, 'sub' | 'loginUserId'>): string {
  return user.loginUserId ?? user.sub;
}
