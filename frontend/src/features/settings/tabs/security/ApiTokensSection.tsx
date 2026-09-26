import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiCode, FiPlus } from 'react-icons/fi';
import { Button, CopyableText, Input, Modal, Skeleton } from '@/components/ui';
import { apiTokensService, type ApiTokenSummary } from '@/services/apiTokensService';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsSection } from '../../components/SettingsSection';
import sectionStyles from '../../components/SettingsSection.module.css';
import styles from '../SecuritySettings.module.css';

export function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiTokenSummary[] | null>(null);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newExpiresInDays, setNewExpiresInDays] = useState('');
  const [creating, setCreating] = useState(false);

  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = () => {
    setLoading(true);
    apiTokensService
      .list()
      .then(setTokens)
      .catch((err) => toast.error(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleCreate = async () => {
    if (!newName.trim()) {
      toast.error('Give this token a name');
      return;
    }
    setCreating(true);
    try {
      const days = newExpiresInDays ? Number(newExpiresInDays) : undefined;
      const result = await apiTokensService.create(newName.trim(), days);
      setCreateOpen(false);
      setNewName('');
      setNewExpiresInDays('');
      setRevealedToken(result.token);
      load();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokingId) return;
    setRevoking(true);
    try {
      await apiTokensService.revoke(revokingId);
      toast.success('Token revoked');
      setRevokingId(null);
      load();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <SettingsSection icon={<FiCode />}
        title="API Tokens"
        description="Personal access tokens for programmatic access to this app's own API."
        footer={
          <Button variant="secondary" leftIcon={<FiPlus />} onClick={() => setCreateOpen(true)}>
            Generate New Token
          </Button>
        }
      >
        {loading ? (
          <Skeleton height={52} />
        ) : !tokens || tokens.length === 0 ? (
          <div className={styles.emptyState}>You haven't created any API tokens yet.</div>
        ) : (
          tokens.map((token) => (
            <div key={token.id} className={styles.sessionRow}>
              <div className={styles.sessionInfo}>
                <span className={styles.sessionDevice}>{token.name}</span>
                <span className={styles.sessionMeta}>
                  {token.prefix}… · created {new Date(token.createdAt).toLocaleDateString()}
                  {token.lastUsedAt ? ` · last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : ' · never used'}
                  {token.expiresAt ? ` · expires ${new Date(token.expiresAt).toLocaleDateString()}` : ''}
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setRevokingId(token.id)}>
                Revoke
              </Button>
            </div>
          ))
        )}
      </SettingsSection>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Generate a new API token"
        description="Give it a name so you can recognize it later. It will only be shown once."
        maxWidth={420}
      >
        <div className={sectionStyles.body}>
          <Input label="Name" placeholder="e.g. CI deploy script" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={creating} />
          <Input
            label="Expires after (days, optional)"
            type="number"
            min={1}
            max={3650}
            placeholder="Never"
            value={newExpiresInDays}
            onChange={(e) => setNewExpiresInDays(e.target.value)}
            disabled={creating}
          />
          <div className={sectionStyles.footer} style={{ borderTop: 'none' }}>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} loading={creating}>
              Generate Token
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={revealedToken !== null}
        onClose={() => setRevealedToken(null)}
        title="Copy your new token"
        description="This is the only time the full token will be shown — store it somewhere safe."
        maxWidth={480}
      >
        <div className={sectionStyles.body}>
          {revealedToken && <CopyableText value={revealedToken} />}
          <p className={styles.warning}>This token will not be shown again after you close this dialog.</p>
          <div className={sectionStyles.footer} style={{ borderTop: 'none' }}>
            <Button onClick={() => setRevealedToken(null)}>I've copied this</Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={revokingId !== null}
        onClose={() => setRevokingId(null)}
        title="Revoke this token?"
        description="Anything using this token will immediately lose access. This cannot be undone."
        maxWidth={420}
      >
        <div className={sectionStyles.footer} style={{ borderTop: 'none', padding: 'var(--space-4)' }}>
          <Button variant="ghost" onClick={() => setRevokingId(null)} disabled={revoking}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirmRevoke()} loading={revoking}>
            Revoke
          </Button>
        </div>
      </Modal>
    </>
  );
}
