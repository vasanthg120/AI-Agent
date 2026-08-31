import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Delegates to the 'admin-jwt' Passport strategy only — a validated
// AdminAccount credential, never a customer User token. Used in place of
// JwtAuthGuard + RolesGuard + @Roles('platform_admin') on every admin-only
// controller: the credential itself is now the gate, since only an
// AdminAccount can ever produce a token this strategy accepts.
@Injectable()
export class AdminJwtAuthGuard extends AuthGuard('admin-jwt') {}
