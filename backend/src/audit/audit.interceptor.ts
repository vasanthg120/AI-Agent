import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { AuditService } from './audit.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// /auth/* is excluded entirely — logging it would mean logging around
// login/register payloads, and the accountability value ("who authenticated
// when") is much lower than the risk of ever accidentally widening this to
// capture credentials later.
const SKIP_ROUTE_PREFIX = '/auth';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const method: string = request.method;
    const route: string = request.originalUrl ?? request.url;

    if (!MUTATING_METHODS.has(method) || route.startsWith(SKIP_ROUTE_PREFIX)) {
      return next.handle();
    }

    const start = Date.now();
    const record = (statusCode: number) => {
      void this.auditService.log({
        userId: request.user?.sub ?? 'anonymous',
        organizationId: request.user?.organizationId,
        method,
        route,
        statusCode,
        durationMs: Date.now() - start,
        ip: request.ip,
        // Someone working in another business acts as their member record there;
        // this keeps the login behind it on the trail.
        ...(request.user?.loginUserId ? { metadata: { loginUserId: request.user.loginUserId } } : {}),
      });
    };

    return next.handle().pipe(
      tap(() => record(context.switchToHttp().getResponse().statusCode)),
      catchError((err) => {
        record(err.status ?? 500);
        return throwError(() => err);
      }),
    );
  }
}
