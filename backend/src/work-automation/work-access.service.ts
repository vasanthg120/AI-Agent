import { Injectable } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { descendantsOf } from '../users/reporting-hierarchy';
import { UsersService } from '../users/users.service';

export const isAdminLike = (caller: Pick<JwtPayload, 'roles'>): boolean => caller.roles.includes('owner') || caller.roles.includes('admin');

/**
 * Who may see or verify whose work. An employee sees their own; an owner/admin
 * sees everyone in the organization; anyone else sees exactly the people who
 * report to them, directly or through others (User.reportingManagerId). Always
 * within the caller's own organization.
 */
@Injectable()
export class WorkAccessService {
  constructor(private users: UsersService) {}

  /** Ids the caller may see, `self` included. For an owner/admin this is every person of the organization. */
  async visibleUserIds(caller: JwtPayload): Promise<string[]> {
    const people = await this.users.hierarchy(caller.organizationId);
    if (isAdminLike(caller)) return people.map((p) => p.id);
    return [caller.sub, ...descendantsOf(caller.sub, people)];
  }

  async canView(caller: JwtPayload, targetUserId: string): Promise<boolean> {
    if (targetUserId === caller.sub) return true;
    return (await this.visibleUserIds(caller)).includes(targetUserId);
  }

  /** Verifier of someone's work: an owner/admin, or a manager above them. Nobody verifies their own work unless they are an owner/admin. */
  async canVerify(caller: JwtPayload, assigneeId: string): Promise<boolean> {
    if (isAdminLike(caller)) return true;
    if (caller.sub === assigneeId) return false;
    const people = await this.users.hierarchy(caller.organizationId);
    return descendantsOf(caller.sub, people).includes(assigneeId);
  }
}
