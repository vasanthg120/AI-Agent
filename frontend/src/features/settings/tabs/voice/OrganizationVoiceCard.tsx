import { Button, Card, Switch } from '@/components/ui';
import type { OrganizationVoicePatch, VoiceConfig, VoicePersonality } from '@/services/voiceConfigService';
import { findVoice } from './voiceLabels';
import styles from './OrganizationVoiceCard.module.css';

// Owner/admin only (the backend enforces it too). Deliberately three controls
// and nothing else: the default voice (chosen from the cards below), the
// default speaking style, and whether people may pick their own.
export function OrganizationVoiceCard({
  config,
  saving,
  onChange,
}: {
  config: VoiceConfig;
  saving: string | null;
  onChange: (patch: OrganizationVoicePatch) => void;
}) {
  const { organization } = config;
  const defaultVoice = findVoice(config, organization.defaultVoiceId);
  const systemVoice = findVoice(config, config.systemDefaultVoiceId);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.title}>Organization defaults</h2>
        <p className={styles.description}>
          How the AI Call Copilot sounds for everyone who hasn't chosen their own voice.
        </p>
      </div>

      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>Default voice</span>
          <span className={styles.rowHint}>
            {defaultVoice
              ? defaultVoice.displayName
              : `Not set — uses ${systemVoice?.displayName ?? 'the system default'}`}
          </span>
          {!defaultVoice && (
            <span className={styles.rowHint}>Choose a voice below with “Set as organization default”.</span>
          )}
        </div>
        {defaultVoice && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ defaultVoiceId: null })}
            loading={saving === 'org'}
          >
            Clear
          </Button>
        )}
      </div>

      <div className={styles.row}>
        <div className={styles.rowText}>
          <label className={styles.rowLabel} htmlFor="voice-org-personality">
            Default speaking style
          </label>
          <span className={styles.rowHint}>Applies unless someone picks their own.</span>
        </div>
        <select
          id="voice-org-personality"
          className={styles.select}
          value={organization.defaultPersonality ?? ''}
          onChange={(e) =>
            onChange({
              defaultPersonality: e.target.value === '' ? null : (e.target.value as VoicePersonality),
            })
          }
        >
          <option value="">Each voice's own style</option>
          {config.personalities.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <Switch
        checked={organization.allowUserOverride}
        onChange={(checked) => onChange({ allowUserOverride: checked })}
        label="Let people choose their own voice"
        description="When off, everyone hears the organization voice and personal choices are paused, not deleted."
      />

      {organization.updatedAt && (
        <p className={styles.footer}>
          Last changed
          {organization.updatedByName ? ` by ${organization.updatedByName}` : ''} on{' '}
          {new Date(organization.updatedAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </p>
      )}
    </Card>
  );
}
