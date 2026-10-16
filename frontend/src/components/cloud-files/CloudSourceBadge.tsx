import clsx from 'clsx';
import { FiDatabase } from 'react-icons/fi';
import { CLOUD_PROVIDER_LABEL, CLOUD_PROVIDER_LOGO, type CloudProviderId } from '@/services/cloudFilesService';
import styles from './cloudFiles.module.css';

/**
 * Where a file lives, in one line: in Google Drive / OneDrive (and where there), or a copy kept in HaiVE.
 * The same words everywhere, so a link to a cloud file is never mistaken for HaiVE's own copy.
 */
export function CloudSourceBadge({ provider, location, copied }: { provider?: CloudProviderId; location?: string; copied?: boolean }) {
  if (copied || !provider)
    return (
      <span className={clsx(styles.provider, styles.providerCopy)}>
        <FiDatabase aria-hidden />
        <span>{provider ? `Copied into HaiVE from ${CLOUD_PROVIDER_LABEL[provider]}` : 'Stored in HaiVE'}</span>
      </span>
    );
  return (
    <span className={styles.provider} title={location ? `${CLOUD_PROVIDER_LABEL[provider]} · ${location}` : CLOUD_PROVIDER_LABEL[provider]}>
      <img src={CLOUD_PROVIDER_LOGO[provider]} alt="" />
      <span>{location ? `${CLOUD_PROVIDER_LABEL[provider]} · ${location}` : CLOUD_PROVIDER_LABEL[provider]}</span>
    </span>
  );
}
