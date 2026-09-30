import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithDataSourceScope } from './data-source-context';
import { DataSourcesService } from './data-sources.service';

// Runs every signed-in request inside its data-source scope: the source the
// person picked in the app (X-Data-Source header — "unified" or a source id),
// otherwise the organization's default. dataSourceScopePlugin then limits
// every CRM read to that scope. Requests without a signed-in organization
// (webhooks, health checks) run unscoped.
@Injectable()
export class DataSourceScopeInterceptor implements NestInterceptor {
  constructor(private dataSources: DataSourcesService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{
      user?: { organizationId?: string };
      headers: Record<string, string | string[] | undefined>;
      query?: Record<string, unknown>;
    }>();
    const organizationId = req.user?.organizationId;
    if (!organizationId) return next.handle();

    const header = req.headers['x-data-source'];
    const selection = (Array.isArray(header) ? header[0] : header) ?? (typeof req.query?.dataSource === 'string' ? req.query.dataSource : undefined);
    const scope = await this.dataSources.resolveScope(organizationId, selection);
    return new Observable((subscriber) => runWithDataSourceScope(scope, () => next.handle().subscribe(subscriber)));
  }
}
