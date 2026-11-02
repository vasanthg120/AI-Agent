// Hoops salespeople usually have no HaiVE login, so their sales can't be
// credited to a HaiVE user the way Pantheras' are (Settings → Deal Assignment).
// The user asked for all of Hoops' data in HaiVE (2026-10-27): each Hoops
// salesperson is listed by their Hoops name in the team views, under the id
// "hoops:<their Hoops id>", and that id opens their own sales in a drill-down.
// Only Hoops: other CRMs' unlinked owners stay as they were (not listed). A
// Hoops salesperson who is linked to a HaiVE user is credited to that user, as
// before, and is not listed twice.

export const HOOPS_SALESPERSON_PREFIX = 'hoops:';

export const isHoopsSalesperson = (id: string): boolean => id.startsWith(HOOPS_SALESPERSON_PREFIX);

export const hoopsSalespersonId = (externalOwnerRef: string): string => `${HOOPS_SALESPERSON_PREFIX}${externalOwnerRef}`;

/** Hoops sales with a Hoops owner and no HaiVE owner — optionally only these Hoops owners. */
export function unlinkedHoopsSales(externalOwnerRefs?: string[]): Record<string, unknown> {
  return {
    sourceProvider: 'hoops',
    ownerId: { $in: [null] },
    externalOwnerRef: externalOwnerRefs ? { $in: externalOwnerRefs } : { $nin: [null, ''] },
  };
}
