import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Model } from 'mongoose';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AdminAccount, AdminAccountDocument } from '../schemas/admin-account.schema';
import { AdminJwtPayload } from '../admin-jwt-payload.interface';

// Named 'admin-jwt' — a completely separate Passport strategy from the
// customer-facing JwtStrategy ('jwt'), backed by AdminAccount instead of
// User. Reuses the same JWT_SECRET/JwtModule config (no new secret
// management) but never reads or writes anything on the User collection.
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService,
    @InjectModel(AdminAccount.name) private adminAccountModel: Model<AdminAccountDocument>,
  ) {
    const secret = config.get<string>('jwt.secret');
    if (!secret) {
      throw new Error('JWT_SECRET is not set');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  // Re-checks `active` on every request (same reasoning as JwtStrategy's own
  // re-fetch) so deactivating an admin account takes effect on its very next
  // call, not just once the token's TTL expires.
  async validate(payload: AdminJwtPayload): Promise<AdminJwtPayload> {
    if (!payload?.sub || !payload.isAdminAccount) {
      throw new UnauthorizedException();
    }
    const account = await this.adminAccountModel.findById(payload.sub).exec();
    if (!account || account.active === false) {
      throw new UnauthorizedException();
    }
    return { sub: account._id.toString(), email: account.email, isAdminAccount: true };
  }
}
