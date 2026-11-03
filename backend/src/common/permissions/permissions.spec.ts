import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { Feature } from '../app-features';
import { Roles } from '../decorators/roles.decorator';
import { FeatureGuard } from '../guards/feature.guard';
import { RolesGuard } from '../guards/roles.guard';
import { normalizePermissions, permissionsFromFeatures } from './app-modules';
import { ModulePermissionInterceptor } from './module-permission.interceptor';
import { NotDelegable, Permission, PermissionExempt } from './permission.decorator';

// Who gets through a route, for each kind of account. "Person" below is someone
// created with an AI role and their own permission list.

@Roles('owner', 'admin', 'manager')
@Permission('customers')
class CustomersController {
  list() {}
  create() {}
  @Permission('customers', 'export')
  export() {}
  @Roles('owner')
  ownerOnly() {}
  @NotDelegable()
  adminOnly() {}
}

// A route every ordinary account may use: no role list, only the module.
@Permission('ai_agent')
class ChatController {
  send() {}
  @PermissionExempt('personal')
  limits() {}
}

@Permission('crm_integrations')
class CrmController {
  connect() {}
}

@Feature('email_inbox')
@Permission('email')
class MailController {
  list() {}
}

const context = (controller: new () => object, handler: string, user: Record<string, unknown> | undefined, method = 'GET') =>
  ({
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user, method }) }),
  }) as unknown as ExecutionContext;

const person = (permissions: string[]) => ({ roles: ['agent_user'], assignedAgentId: 'sales', permissions });

describe('normalizePermissions', () => {
  it('keeps only real entries, adds the page for any action, and sorts them like the catalog', () => {
    expect(normalizePermissions(['customers:edit', 'nope:view', 'customers:fly', 'dashboard:view', 'customers:edit'])).toEqual([
      'dashboard:view',
      'customers:view',
      'customers:edit',
    ]);
    expect(normalizePermissions([])).toEqual([]);
  });

  it('starts an older AI role’s people from the basics plus what its features meant', () => {
    const list = permissionsFromFeatures(['inquiries']);
    expect(list).toEqual(expect.arrayContaining(['dashboard:view', 'ai_agent:create', 'customers:edit', 'job_board:view']));
    expect(list).not.toContain('email:view');
    expect(list).not.toContain('customers:delete');
  });
});

describe('RolesGuard with a permission list', () => {
  const guard = new RolesGuard(new Reflector());

  it('lets a person in for exactly the actions they were given', () => {
    expect(guard.canActivate(context(CustomersController, 'list', person(['customers:view'])))).toBe(true);
    expect(() => guard.canActivate(context(CustomersController, 'create', person(['customers:view']), 'POST'))).toThrow(
      'You don’t have permission to add to Customers. Ask an admin for access.',
    );
    expect(guard.canActivate(context(CustomersController, 'create', person(['customers:view', 'customers:create']), 'POST'))).toBe(true);
    expect(() => guard.canActivate(context(CustomersController, 'export', person(['customers:view'])))).toThrow(ForbiddenException);
    expect(guard.canActivate(context(CustomersController, 'export', person(['customers:view', 'customers:export'])))).toBe(true);
    expect(() => guard.canActivate(context(CustomersController, 'list', person([])))).toThrow(ForbiddenException);
  });

  it('never opens an owner-only or not-delegable route, whatever they were given', () => {
    const everything = person(['customers:view', 'customers:create', 'customers:edit', 'customers:delete', 'customers:export']);
    expect(() => guard.canActivate(context(CustomersController, 'ownerOnly', everything))).toThrow('Insufficient role');
    expect(() => guard.canActivate(context(CustomersController, 'adminOnly', everything))).toThrow('Insufficient role');
  });

  it('a person is not let in by their AI role’s older feature list', () => {
    expect(() => guard.canActivate(context(CustomersController, 'list', { ...person([]), features: ['inquiries'] }))).toThrow(ForbiddenException);
  });

  it('owners, admins and managers pass exactly as before', () => {
    expect(guard.canActivate(context(CustomersController, 'create', { roles: ['owner', 'admin'] }, 'POST'))).toBe(true);
    expect(guard.canActivate(context(CustomersController, 'adminOnly', { roles: ['admin'] }))).toBe(true);
    expect(guard.canActivate(context(CustomersController, 'list', { roles: ['manager'] }))).toBe(true);
  });

  it('a permission list on an admin means nothing', () => {
    expect(guard.canActivate(context(CustomersController, 'ownerOnly', { roles: ['owner', 'admin'], permissions: [] }))).toBe(true);
  });
});

describe('ModulePermissionInterceptor', () => {
  const interceptor = new ModulePermissionInterceptor(new Reflector());
  // async, so a refusal thrown on the spot (as Nest allows) arrives as a rejection.
  const run = async (ctx: ExecutionContext) => lastValueFrom(interceptor.intercept(ctx, { handle: () => of('ran') }));

  it('holds a person to their list on routes nobody’s role restricts', async () => {
    await expect(run(context(ChatController, 'send', person(['ai_agent:view']), 'POST'))).rejects.toThrow(
      'You don’t have permission to add to AI Agent. Ask an admin for access.',
    );
    await expect(run(context(ChatController, 'send', person(['ai_agent:view', 'ai_agent:create']), 'POST'))).resolves.toBe('ran');
  });

  it('leaves personal routes, admins and older accounts alone', async () => {
    await expect(run(context(ChatController, 'limits', person([])))).resolves.toBe('ran');
    await expect(run(context(ChatController, 'send', { roles: ['admin'] }, 'POST'))).resolves.toBe('ran');
    await expect(run(context(ChatController, 'send', { roles: ['agent_user'], features: [] }, 'POST'))).resolves.toBe('ran');
    await expect(run(context(ChatController, 'send', undefined, 'POST'))).resolves.toBe('ran');
  });

  it('on a page with only view and manage, any change needs manage', async () => {
    await expect(run(context(CrmController, 'connect', person(['crm_integrations:view']), 'POST'))).rejects.toThrow(
      'You don’t have permission to manage CRM Integrations.',
    );
    await expect(run(context(CrmController, 'connect', person(['crm_integrations:view', 'crm_integrations:manage']), 'POST'))).resolves.toBe('ran');
  });

  it('refuses a not-delegable route to a person outright', async () => {
    await expect(run(context(CustomersController, 'adminOnly', person(['customers:view'])))).rejects.toThrow('Only owners and admins can do this.');
  });
});

describe('FeatureGuard with a permission list', () => {
  const guard = new FeatureGuard(new Reflector());

  it('uses the person’s list instead of their AI role’s features', () => {
    expect(guard.canActivate(context(MailController, 'list', person(['email:view'])))).toBe(true);
    expect(() => guard.canActivate(context(MailController, 'list', { ...person([]), features: ['email_inbox'] }))).toThrow(ForbiddenException);
  });
});
