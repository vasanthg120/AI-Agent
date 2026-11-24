import { descendantsOf, wouldCreateCycle } from './reporting-hierarchy';

describe('reporting hierarchy', () => {
  const chain: Record<string, string | undefined> = { a: undefined, b: 'a', c: 'b' };
  const managerOf = (id: string) => chain[id];

  it('rejects self-management', () => {
    expect(wouldCreateCycle('a', 'a', managerOf)).toBe(true);
  });
  it('rejects a manager who already reports (directly or not) to the user', () => {
    expect(wouldCreateCycle('a', 'b', managerOf)).toBe(true);
    expect(wouldCreateCycle('a', 'c', managerOf)).toBe(true);
  });
  it('allows a valid manager', () => {
    expect(wouldCreateCycle('c', 'a', managerOf)).toBe(false);
    expect(wouldCreateCycle('x', 'c', managerOf)).toBe(false);
  });
  it('treats an already-corrupt looping chain as a cycle instead of hanging', () => {
    const loop: Record<string, string> = { p: 'q', q: 'p' };
    expect(wouldCreateCycle('z', 'p', (id) => loop[id])).toBe(true);
  });
  it('lists direct and indirect reports once, even with a loop in the data', () => {
    const people = [
      { id: 'b', reportingManagerId: 'a' },
      { id: 'c', reportingManagerId: 'b' },
      { id: 'd', reportingManagerId: 'c' },
      { id: 'a', reportingManagerId: 'd' },
    ];
    expect(descendantsOf('a', people).sort()).toEqual(['b', 'c', 'd']);
  });
});
