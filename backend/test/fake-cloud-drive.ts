import { Readable } from 'stream';
import { CloudError } from '../src/cloud-files/cloud-http';
import { CloudItem, ROOT_REF, SHARED_REF } from '../src/cloud-files/cloud-files.types';

// Test double for a Google Drive / OneDrive account, shared by the cloud-files specs.
// A drive in memory: My Drive → Sales → Acme → quote.pdf, and My Drive → HR → payroll.xlsx.
export interface FakeNode {
  name: string;
  kind: 'folder' | 'file';
  parent?: string;
  mimeType?: string;
}

export function fakeDrive(id: 'google_drive' | 'onedrive') {
  const nodes: Record<string, FakeNode> = {
    [ROOT_REF]: { name: 'My Drive', kind: 'folder' },
    sales: { name: 'Sales', kind: 'folder', parent: ROOT_REF },
    acme: { name: 'Acme', kind: 'folder', parent: 'sales' },
    quote: { name: 'quote.pdf', kind: 'file', parent: 'acme', mimeType: 'application/pdf' },
    hr: { name: 'HR', kind: 'folder', parent: ROOT_REF },
    payroll: { name: 'payroll.xlsx', kind: 'file', parent: 'hr' },
  };
  let created = 0;
  const item = (nodeId: string): CloudItem => {
    const node = nodes[nodeId];
    if (!node) throw new CloudError('not_found', 'gone');
    return { id: nodeId, name: node.name, kind: node.kind, mimeType: node.mimeType, parentId: node.parent, ...(nodeId === ROOT_REF ? { root: true } : {}) };
  };
  const tokens: string[] = [];
  const provider = {
    id,
    rejectToken: undefined as string | undefined,
    /** Whether the account behind a token may see an item (as if shared with it). Everything, unless a test says otherwise. */
    canSee: (_token: string, _itemId: string) => true,
    failRefresh: false,
    refreshes: 0,
    tokens,
    nodes,
    configured: () => true,
    permissions: () => ['Files'],
    authorizeUrl: (state: string) => `https://provider.test/auth?state=${state}`,
    exchangeCode: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, scope: 'files' }),
    refresh: jest.fn(async () => {
      provider.refreshes += 1;
      if (provider.failRefresh) throw new CloudError('auth', 'revoked', 'invalid_grant');
      return { accessToken: `access-${provider.refreshes + 1}`, refreshToken: `refresh-${provider.refreshes + 1}`, expiresIn: 3600, scope: 'files' };
    }),
    account: async () => ({ accountId: 'acct-1', email: 'drive@acme.test', name: 'Drive' }),
    revoke: jest.fn(async () => undefined),
    check(token: string, itemId?: string) {
      tokens.push(token);
      if (provider.rejectToken === token) throw new CloudError('auth', 'expired', '401');
      if (itemId !== undefined && !provider.canSee(token, itemId)) throw new CloudError('not_found', 'not shared with this account');
    },
    roots: async (token: string) => {
      provider.check(token);
      return [item(ROOT_REF), { id: SHARED_REF, name: 'Shared with me', kind: 'folder' as const, root: true }];
    },
    list: async (token: string, folderId: string) => {
      provider.check(token, folderId);
      return { items: Object.keys(nodes).filter((k) => nodes[k].parent === folderId).map(item) };
    },
    search: async (token: string, options: { query: string }) => {
      provider.check(token);
      return { items: Object.keys(nodes).filter((k) => k !== ROOT_REF && nodes[k].name.toLowerCase().includes(options.query.toLowerCase())).map(item) };
    },
    get: async (token: string, itemId: string) => {
      provider.check(token, itemId);
      return item(itemId);
    },
    ancestors: async (token: string, itemId: string) => {
      provider.check(token);
      const chain: CloudItem[] = [];
      let parent = nodes[itemId]?.parent;
      while (parent) {
        chain.push(item(parent));
        parent = nodes[parent].parent;
      }
      return chain;
    },
    download: async (token: string, itemId: string) => {
      provider.check(token, itemId);
      const node = nodes[itemId];
      if (!node) throw new CloudError('not_found', 'gone');
      return { stream: Readable.from([Buffer.from('content')]), name: node.name, mimeType: node.mimeType ?? 'application/octet-stream', size: 7 };
    },
    preview: async (_token: string, it: CloudItem) => (it.mimeType === 'application/pdf' ? { kind: 'inline' as const } : { kind: 'link' as const, url: 'https://x' }),
    createFolder: async (token: string, parentId: string, name: string) => {
      provider.check(token);
      const existing = Object.keys(nodes).find((k) => nodes[k].parent === parentId && nodes[k].name === name && nodes[k].kind === 'folder');
      if (existing) return item(existing);
      const newId = `new-${++created}`;
      nodes[newId] = { name, kind: 'folder', parent: parentId };
      return item(newId);
    },
    update: async (token: string, itemId: string, change: { name?: string; parentId?: string }) => {
      provider.check(token);
      if (change.name) nodes[itemId].name = change.name;
      if (change.parentId) nodes[itemId].parent = change.parentId;
      return item(itemId);
    },
    remove: async (token: string, itemId: string) => {
      provider.check(token);
      delete nodes[itemId];
    },
    upload: async (token: string, parentId: string, name: string) => {
      provider.check(token);
      const newId = `up-${++created}`;
      nodes[newId] = { name, kind: 'file', parent: parentId };
      return item(newId);
    },
  };
  return provider;
}

