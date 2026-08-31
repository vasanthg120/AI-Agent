// Deliberately minimal and shaped nothing like JwtPayload (backend/src/auth/jwt-payload.interface.ts)
// — no organizationId, no roles array, no session/jti tracking. isAdminAccount
// is a fixed literal so nothing can accidentally forge this shape from a
// customer token; AdminJwtStrategy is the only place that sets it.
export interface AdminJwtPayload {
  sub: string;
  email: string;
  isAdminAccount: true;
}
