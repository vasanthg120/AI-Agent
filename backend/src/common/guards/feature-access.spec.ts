import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Feature } from '../app-features';
import { Roles } from '../decorators/roles.decorator';
import { FeatureGuard } from './feature.guard';
import { RolesGuard } from './roles.guard';

// What an account tied to an AI role may reach: the features its AI role
// includes — and never the admin-only routes inside a feature.

@Roles('owner', 'admin', 'manager')
@Feature('inquiries')
class LeadsController {
  list() {}
  @Roles('owner', 'admin')
  adminOnly() {}
}

@Feature('email_inbox')
class MailController {
  list() {}
}

class PlainController {
  list() {}
}

const context = (controller: new () => object, handler: string, user: Record<string, unknown> | undefined) =>
  ({
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const teamMember = (features: string[]) => ({ roles: ['agent_user'], features });

describe('RolesGuard with AI-role features', () => {
  const guard = new RolesGuard(new Reflector());

  it('lets a fixed role through exactly as before', () => {
    expect(guard.canActivate(context(LeadsController, 'list', { roles: ['manager'] }))).toBe(true);
    expect(() => guard.canActivate(context(LeadsController, 'list', { roles: ['consultant'] }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context(LeadsController, 'list', undefined))).toThrow(ForbiddenException);
  });

  it('lets a team member in when their AI role includes the feature, and not otherwise', () => {
    expect(guard.canActivate(context(LeadsController, 'list', teamMember(['inquiries'])))).toBe(true);
    expect(() => guard.canActivate(context(LeadsController, 'list', teamMember(['email_inbox'])))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context(LeadsController, 'list', teamMember([])))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context(LeadsController, 'list', { roles: ['agent_user'] }))).toThrow(ForbiddenException);
  });

  it('never opens a route that names its own roles, even inside a granted feature', () => {
    expect(() => guard.canActivate(context(LeadsController, 'adminOnly', teamMember(['inquiries'])))).toThrow(ForbiddenException);
    expect(guard.canActivate(context(LeadsController, 'adminOnly', { roles: ['admin'] }))).toBe(true);
  });

  it('a feature list means nothing for an account that is not tied to an AI role', () => {
    expect(() => guard.canActivate(context(LeadsController, 'list', { roles: ['user'], features: ['inquiries'] }))).toThrow(ForbiddenException);
  });
});

describe('FeatureGuard', () => {
  const guard = new FeatureGuard(new Reflector());

  it('does not affect ordinary accounts or routes without a feature', () => {
    expect(guard.canActivate(context(MailController, 'list', { roles: ['user'] }))).toBe(true);
    expect(guard.canActivate(context(MailController, 'list', { roles: ['owner', 'admin'] }))).toBe(true);
    expect(guard.canActivate(context(PlainController, 'list', teamMember([])))).toBe(true);
  });

  it('holds a team member to what their AI role includes', () => {
    expect(guard.canActivate(context(MailController, 'list', teamMember(['email_inbox'])))).toBe(true);
    expect(() => guard.canActivate(context(MailController, 'list', teamMember(['call_copilot'])))).toThrow(ForbiddenException);
  });

  it('an admin who also carries the team-member role is not restricted', () => {
    expect(guard.canActivate(context(MailController, 'list', { roles: ['admin', 'agent_user'], features: [] }))).toBe(true);
  });
});
