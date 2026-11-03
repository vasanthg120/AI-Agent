import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiAlertCircle, FiDownload, FiExternalLink } from 'react-icons/fi';
import { Button, EmptyState, Modal, Spinner } from '@/components/ui';
import { CLOUD_PROVIDER_LABEL, saveBlob, type CloudItem, type CloudProviderId } from '@/services/cloudFilesService';
import type { CloudSource } from './cloudSources';
import { extractErrorMessage } from '@/utils/errors';
import { downloadName, formatBytes, formatModified } from './cloudFormat';
import styles from './cloudFiles.module.css';

const TEXT_LIMIT = 200_000;

// A look at a cloud file without leaving HaiVE: an image, a PDF or plain text as it
// is; a Google document as a PDF made from it; an Office file in Microsoft's own
// viewer. Anything else opens in Google Drive / OneDrive itself.
export function CloudPreviewModal({ provider, source, item, onClose }: { provider: CloudProviderId; source: CloudSource; item: CloudItem | null; onClose: () => void }) {
  return (
    <Modal open={!!item} onClose={onClose} title={item?.name} maxWidth={960}>
      {item && <PreviewBody provider={provider} source={source} item={item} />}
    </Modal>
  );
}

function PreviewBody({ provider: providerId, source, item }: { provider: CloudProviderId; source: CloudSource; item: CloudItem }) {
  const provider = CLOUD_PROVIDER_LABEL[providerId];
  const preview = useQuery({ queryKey: ['cloud-files', source.key, 'preview', item.id], queryFn: () => source.preview(item.id), staleTime: 30_000 });
  const showsContent = preview.data?.kind === 'inline' || preview.data?.kind === 'pdf';
  const content = useQuery({
    queryKey: ['cloud-files', source.key, 'inline', item.id],
    queryFn: () => source.content(item.id, { inline: true }),
    enabled: showsContent,
    staleTime: 60_000,
  });
  const [url, setUrl] = useState<string>();
  const [text, setText] = useState<string>();
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!content.data) return;
    if (content.data.type.startsWith('text/')) {
      void content.data.slice(0, TEXT_LIMIT).text().then(setText);
      return;
    }
    const objectUrl = URL.createObjectURL(content.data);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [content.data]);

  const download = async () => {
    setDownloading(true);
    try {
      saveBlob(await source.content(item.id), downloadName(item));
    } catch (failure) {
      toast.error(`${item.name}: ${extractErrorMessage(failure)}`);
    } finally {
      setDownloading(false);
    }
  };

  const error = preview.error ?? content.error;
  let body;
  if (preview.isLoading || content.isLoading) body = <Spinner />;
  else if (error) body = <EmptyState compact icon={FiAlertCircle} title="This file can’t be shown" description={extractErrorMessage(error)} />;
  else if (showsContent && text !== undefined) body = <pre>{text}</pre>;
  else if (showsContent && url && content.data?.type.startsWith('image/')) body = <img src={url} alt={item.name} />;
  else if (showsContent && url) body = <iframe src={url} title={item.name} />;
  else if (preview.data?.kind === 'embed' && preview.data.url)
    // Microsoft's viewer page, kept in a sandbox.
    body = <iframe src={preview.data.url} title={item.name} sandbox="allow-scripts allow-same-origin allow-popups allow-forms" />;
  else
    body = (
      <EmptyState
        compact
        title="No preview for this kind of file"
        description={item.webUrl ? `Open it in ${provider} or download it.` : 'Download it to open it.'}
      />
    );

  return (
    <div>
      <div className={styles.preview}>{body}</div>
      <div className={styles.previewFacts}>
        <span>{provider}</span>
        {item.size !== undefined && <span>{formatBytes(item.size)}</span>}
        {item.modifiedAt && <span>Modified {formatModified(item.modifiedAt)}</span>}
        {item.owner && <span>Owner: {item.owner}</span>}
      </div>
      <div className={styles.dialogActions}>
        {item.webUrl && (
          <Button variant="secondary" size="sm" leftIcon={<FiExternalLink />} onClick={() => window.open(item.webUrl, '_blank', 'noopener,noreferrer')}>
            Open in {provider}
          </Button>
        )}
        <Button size="sm" leftIcon={<FiDownload />} loading={downloading} onClick={() => void download()}>
          Download
        </Button>
      </div>
    </div>
  );
}
