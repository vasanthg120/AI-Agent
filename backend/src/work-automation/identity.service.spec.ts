import { FakeModel } from './testing/fake-model';
import { IdentityService, identityKey } from './identity.service';

describe('IdentityService: external platform user -> HaiVE employee', () => {
  let users: FakeModel;
  let identities: FakeModel;
  let service: IdentityService;
  let sanjayId: string;

  beforeEach(async () => {
    users = new FakeModel();
    identities = new FakeModel([['organizationId', 'platform', 'externalUserId']]);
    service = new IdentityService(identities as never, users as never);
    sanjayId = (await users.create({ organizationId: 'org1', email: 'sanjay@pantheras.io', name: 'Sanjay', active: true }))!._id;
  });

  it('links by verified email and remembers the platform-specific id', async () => {
    const id = await service.resolve('org1', 'Hoops', { externalUserId: 'H-77', email: 'Sanjay@Pantheras.io' });
    expect(id).toBe(sanjayId);
    // The same person on another platform has a different id: separate row, same employee.
    expect(await service.resolve('org1', 'pantheras', { externalUserId: 'P-9', email: 'sanjay@pantheras.io' })).toBe(sanjayId);
    expect((await service.identitiesOfUser('org1', sanjayId)).map((i) => i.platform).sort()).toEqual(['hoops', 'pantheras']);
  });

  it('never assigns on a display name alone', async () => {
    expect(await service.resolve('org1', 'hoops', { displayName: 'Sanjay' })).toBeNull();
    // Even with an id: a matching name with no email stays unresolved and is flagged.
    expect(await service.resolve('org1', 'hoops', { externalUserId: 'H-5', displayName: 'Sanjay' })).toBeNull();
    const [row] = await service.list('org1', 'unresolved');
    expect(row).toMatchObject({ externalUserId: 'H-5', externalName: 'Sanjay', status: 'unresolved' });
  });

  it('counts repeated sightings of an unresolved person once, not as duplicates', async () => {
    await service.resolve('org1', 'hoops', { externalUserId: 'H-5' });
    await service.resolve('org1', 'hoops', { externalUserId: 'H-5' });
    expect(identities.docs).toHaveLength(1);
    expect(identities.docs[0].seenCount).toBe(2);
    expect(await service.unresolvedCount('org1')).toBe(1);
  });

  it('does not match an employee of another organization', async () => {
    expect(await service.resolve('org2', 'hoops', { externalUserId: 'H-1', email: 'sanjay@pantheras.io' })).toBeNull();
  });

  it('does not match an inactive employee', async () => {
    users.docs[0].active = false;
    expect(await service.resolve('org1', 'hoops', { externalUserId: 'H-1', email: 'sanjay@pantheras.io' })).toBeNull();
  });

  it('leaves an ambiguous email (two accounts) unresolved', async () => {
    await users.create({ organizationId: 'org1', email: 'sanjay@pantheras.io', name: 'Sanjay (member)', active: true });
    expect(await service.resolve('org1', 'hoops', { externalUserId: 'H-1', email: 'sanjay@pantheras.io' })).toBeNull();
  });

  it('lets an admin link, and a later deactivation stops assignment', async () => {
    await service.resolve('org1', 'hoops', { externalUserId: 'H-9', email: 'sal@hoops.example' });
    const [row] = await service.list('org1', 'unresolved');
    await service.link('org1', row.id, sanjayId, 'admin1');
    expect(await service.resolve('org1', 'hoops', { externalUserId: 'H-9' })).toBe(sanjayId);
    users.docs[0].active = false;
    expect(await service.resolve('org1', 'hoops', { externalUserId: 'H-9' })).toBeNull();
  });

  it('refuses to link to someone outside the organization or inactive', async () => {
    const other = (await users.create({ organizationId: 'org2', email: 'x@y.z', name: 'X', active: true }))!._id;
    await service.resolve('org1', 'hoops', { externalUserId: 'H-9' });
    const [row] = await service.list('org1');
    await expect(service.link('org1', row.id, other, 'a')).rejects.toThrow(/active person of this business/);
  });

  it('cannot touch another organization identity', async () => {
    await service.resolve('org1', 'hoops', { externalUserId: 'H-9' });
    const [row] = await service.list('org1');
    await expect(service.ignore('org2', row.id, 'a')).rejects.toThrow(/not found/i);
  });

  it('ignored identities stay unassigned even if their email matches later', async () => {
    await service.resolve('org1', 'hoops', { externalUserId: 'shared' });
    const [row] = await service.list('org1');
    await service.ignore('org1', row.id, 'a');
    expect(await service.resolve('org1', 'hoops', { externalUserId: 'shared', email: 'sanjay@pantheras.io' })).toBeNull();
  });

  it('keys on id, falling back to email, never on a name', () => {
    expect(identityKey({ externalUserId: ' 7 ', email: 'a@b.c' })).toBe('7');
    expect(identityKey({ email: 'A@B.C' })).toBe('a@b.c');
    expect(identityKey({ displayName: 'Sanjay' })).toBeUndefined();
  });
});
