import { Connection } from 'mongoose';

/** Businesses that have been archived. Scheduled jobs leave these alone; nobody can
 * sign in to them, and their data stays as it was until they are restored. */
export async function archivedOrganizationIds(connection: Connection): Promise<string[]> {
  const rows = await connection.collection('organizations').find({ status: 'archived' }, { projection: { _id: 1 } }).toArray();
  return rows.map((row) => row._id.toString());
}
