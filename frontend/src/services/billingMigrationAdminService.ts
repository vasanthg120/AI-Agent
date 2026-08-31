import { adminAxiosClient } from '@/api/adminAxiosClient';

export interface WalletMergeSourceSummary {
  walletId: string;
  originalKey: string;
  balanceCredits: number;
  reservedCredits: number;
}

export interface OrganizationMigrationPlan {
  organizationId: string;
  action: 'none' | 'rename' | 'merge';
  sourceWallets: WalletMergeSourceSummary[];
  targetWalletId?: string;
  mergedBalanceCredits?: number;
  mergedReservedCredits?: number;
}

export interface MigrationRunResult {
  dryRun: boolean;
  organizations: OrganizationMigrationPlan[];
}

// POST /billing/admin/migrate-organization-wallets — idempotent, dry-run by
// default (see billing-migration.service.ts). This page never defaults to a
// real run; the caller must explicitly confirm before dryRun=false is sent.
export const billingMigrationAdminService = {
  async run(dryRun: boolean, organizationId?: string): Promise<MigrationRunResult> {
    const { data } = await adminAxiosClient.post<MigrationRunResult>('/billing/admin/migrate-organization-wallets', null, {
      params: { dryRun, organizationId },
    });
    return data;
  },
};
