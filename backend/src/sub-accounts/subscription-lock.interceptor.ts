import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Observable, from, switchMap } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { hasLiveSubscription, subscriptionRequired } from './subscription-access';

// What a locked sub-account can still reach: paying, signing in and security, the
// person's own profile, and account settings (General, Notifications, Security,
// Users). Everything else answers 402 until there is a subscription.
const ALWAYS_OPEN = ['/billing', '/auth', '/users', '/sessions', '/api-tokens', '/notifications', '/organizations', '/store-settings', '/health'];
// The Users page lists AI roles when adding a person; reading them changes nothing.
const OPEN_FOR_READING = ['/agent-roles'];

function isOpen(method: string, path: string): boolean {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return ALWAYS_OPEN.some(under) || (method === 'GET' && OPEN_FOR_READING.some(under));
}

// A global interceptor because guards decide who someone is; this runs right after
// them, so request.user is known. Main Accounts never reach the database here:
// JwtStrategy has already said whether this is a sub-account. Python's internal
// calls (authMethod 'service') aren't stopped here but at ReservationService, which
// every AI feature goes through, background work included.
@Injectable()
export class SubscriptionLockInterceptor implements NestInterceptor {
  constructor(@InjectConnection() private connection: Connection) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;
    if (!user?.isSubAccount || user.authMethod === 'service' || isOpen(request.method, request.path)) return next.handle();

    return from(hasLiveSubscription(this.connection, user.organizationId)).pipe(
      switchMap((live) => {
        if (!live) throw subscriptionRequired();
        return next.handle();
      }),
    );
  }
}
