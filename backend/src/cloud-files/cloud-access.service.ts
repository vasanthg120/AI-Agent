import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CloudConnectionsService, isOrgAdmin } from './cloud-connections.service';
import { CLOUD_PROVIDER_LABEL, CloudItem, ROOT_REF, SHARED_REF } from './cloud-files.types';
import { CloudConnectionDocument } from './schemas/cloud-connection.schema';
import { CloudFolderGrant, CloudFolderGrantDocument } from './schemas/cloud-folder-grant.schema';

const ANCESTRY_TTL_MS = 60_000;
const ANCESTRY_CACHE_LIMIT = 5_000;

export type CloudNeed = 'view' | 'edit';

/** What the person asking may do with one connection. */
export interface CloudScope {
  connection: CloudConnectionDocument;
  /** Their own account, or an owner/admin on the company account: everything the account itself can reach. */
  all: boolean;
  /** Otherwise: the company folders opened to their role. */
  grants: { folderId: string; name: string; access: 'view' | 'edit' }[];
}

// Who may open what of a connected Google Drive or OneDrive. Connecting an account
// never opens it to the whole organization:
//   - a personal account is used only by the person who connected it;
//   - the company account is wholly open to owners and admins, and to everyone
//     else only below the folders granted to their role (view or edit).
// Whatever HaiVE allows, the provider still applies its own permissions to the
// account's token on top.
@Injectable()
export class CloudAccessService {
  // Which folders an item sits in, per connection — walking up costs a call per level, so it is kept a minute.
  private readonly ancestry = new Map<string, { at: number; chain: string[] }>();

  constructor(
    private connections: CloudConnectionsService,
    @InjectModel(CloudFolderGrant.name) private grants: Model<CloudFolderGrantDocument>,
  ) {}

  async open(caller: JwtPayload, connectionId: string): Promise<CloudScope> {
    const connection = await this.connections.find(caller.organizationId, connectionId);
    if (connection.ownership === 'personal') {
      // Someone else's own account doesn't exist, as far as the person asking can tell.
      if (connection.userId !== caller.sub) throw new NotFoundException('That account isn’t connected.');
      return { connection, all: true, grants: [] };
    }
    if (isOrgAdmin(caller)) return { connection, all: true, grants: [] };
    const grants = await this.grants
      .find({ organizationId: caller.organizationId, connectionId: connection._id.toString(), roles: { $in: caller.roles } })
      .exec();
    if (grants.length === 0)
      throw new ForbiddenException(`No folders of the company ${CLOUD_PROVIDER_LABEL[connection.provider]} are shared with your role.`);
    return { connection, all: false, grants: grants.map((g) => ({ folderId: g.folderId, name: g.name, access: g.access })) };
  }

  /** The item and the folders above it, nearest first (cached briefly). */
  async chain(scope: CloudScope, itemId: string): Promise<string[]> {
    const key = `${scope.connection._id.toString()}:${itemId}`;
    const hit = this.ancestry.get(key);
    if (hit && Date.now() - hit.at < ANCESTRY_TTL_MS) return hit.chain;
    const provider = this.connections.provider(scope.connection.provider);
    const ancestors = await this.connections.withToken(scope.connection, (token) => provider.ancestors(token, itemId));
    const chain = [itemId, ...ancestors.map((a) => a.id)];
    if (this.ancestry.size >= ANCESTRY_CACHE_LIMIT) this.ancestry.clear();
    this.ancestry.set(key, { at: Date.now(), chain });
    return chain;
  }

  /** Forgets what is known about where an item is (after a move). */
  forget(scope: CloudScope, itemId: string) {
    const prefix = `${scope.connection._id.toString()}:`;
    for (const key of this.ancestry.keys()) if (key.startsWith(prefix) && (key.endsWith(`:${itemId}`) || this.ancestry.get(key)?.chain.includes(itemId))) this.ancestry.delete(key);
  }

  /** The grant an item falls under, or undefined. */
  private async grantFor(scope: CloudScope, itemId: string) {
    if (itemId === ROOT_REF || itemId === SHARED_REF) return undefined;
    const direct = scope.grants.find((g) => g.folderId === itemId);
    if (direct) return direct;
    const chain = await this.chain(scope, itemId);
    // The nearest granted folder decides (an edit grant inside a view-only one still allows editing there).
    for (const id of chain) {
      const grant = scope.grants.find((g) => g.folderId === id);
      if (grant) return grant;
    }
    return undefined;
  }

  /** Throws unless the person asking may `need` the item (a file, or a folder and what is in it). */
  async assert(scope: CloudScope, itemId: string, need: CloudNeed): Promise<void> {
    if (scope.all) return;
    const grant = await this.grantFor(scope, itemId);
    if (!grant) throw new NotFoundException('That file or folder isn’t shared with your role.');
    if (need === 'edit' && grant.access !== 'edit') throw new ForbiddenException('Your role can look at this folder but not change it.');
  }

  /** Keeps only the items the person asking may see (search results across a company account). */
  async visible(scope: CloudScope, items: CloudItem[]): Promise<CloudItem[]> {
    if (scope.all) return items;
    const allowed = await Promise.all(items.map((item) => this.grantFor(scope, item.id).then((g) => !!g, () => false)));
    return items.filter((_, i) => allowed[i]);
  }

  /** May they change things in the folder they are looking at? */
  async canEdit(scope: CloudScope, folderId: string): Promise<boolean> {
    if (scope.all) return true;
    return (await this.grantFor(scope, folderId))?.access === 'edit';
  }

  /** Breadcrumbs as the person may follow them: for a granted folder, they start at that folder. */
  async trim(scope: CloudScope, path: CloudItem[]): Promise<CloudItem[]> {
    if (scope.all) return path;
    const start = path.findIndex((item) => scope.grants.some((g) => g.folderId === item.id));
    return start === -1 ? [] : path.slice(start);
  }
}
