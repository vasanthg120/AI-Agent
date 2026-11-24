import { FakeModel } from '../work-automation/testing/fake-model';
import { UsersService } from './users.service';

describe('UsersService: reporting manager validation', () => {
  let users: FakeModel;
  let service: UsersService;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    users = new FakeModel();
    service = new UsersService(users as never, new FakeModel() as never);
    for (const [key, org, active] of [['boss', 'org1', true], ['mid', 'org1', true], ['emp', 'org1', true], ['gone', 'org1', false], ['alien', 'org2', true]] as const) {
      ids[key] = (await users.create({ organizationId: org, email: `${key}@x.io`, name: key, active }))!._id;
    }
    users.docs.find((d) => d._id === ids.emp)!.reportingManagerId = ids.mid;
    users.docs.find((d) => d._id === ids.mid)!.reportingManagerId = ids.boss;
  });

  it('accepts an active manager of the same business', async () => {
    await expect(service.assertValidReportingManager('org1', ids.emp, ids.boss)).resolves.toBeUndefined();
  });
  it('rejects self, inactive, other-organization and unknown managers', async () => {
    await expect(service.assertValidReportingManager('org1', ids.emp, ids.emp)).rejects.toThrow(/themself/);
    await expect(service.assertValidReportingManager('org1', ids.emp, ids.gone)).rejects.toThrow(/active/);
    await expect(service.assertValidReportingManager('org1', ids.emp, ids.alien)).rejects.toThrow(/in this business/);
    await expect(service.assertValidReportingManager('org1', ids.emp, 'nope')).rejects.toThrow(/Choose a reporting manager/);
  });
  it('rejects a loop (boss reporting to their own report)', async () => {
    await expect(service.assertValidReportingManager('org1', ids.boss, ids.emp)).rejects.toThrow(/loop/);
  });
  it('hierarchy lists the business only', async () => {
    const h = await service.hierarchy('org1');
    expect(h.map((p) => p.id)).not.toContain(ids.alien);
    expect(h.find((p) => p.id === ids.emp)?.reportingManagerId).toBe(ids.mid);
  });
});
