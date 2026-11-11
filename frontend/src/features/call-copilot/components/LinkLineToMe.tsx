import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input } from '@/components/ui';
import { callingService, linkedLine, type CallingOverview } from '@/services/callingService';
import { plivoService, formatPhone, type PlivoConfig, type PlivoLine } from '@/services/plivoService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './PhoneCallCard.module.css';

interface LinkLineToMeProps {
  lines: PlivoLine[];
  userId: string;
  defaultCountryCode: string;
  onOpenSettings: () => void;
}

// For an administrator who can't call because every Plivo number is linked to someone else. A number belongs to one
// person at a time (it is where inbound calls ring), so taking it over is spelled out before it happens.
export function LinkLineToMe({ lines, userId, defaultCountryCode, onOpenSettings }: LinkLineToMeProps) {
  const queryClient = useQueryClient();
  const ordered = [...lines].sort((a, b) => Number(b.active) - Number(a.active));
  const [plivoNumber, setPlivoNumber] = useState(ordered[0].plivoNumber);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const chosen = ordered.find((l) => l.plivoNumber === plivoNumber) ?? ordered[0];
  const otherOwners = chosen.userId !== userId;

  // Saving the line and being able to call are different things: a call also needs the
  // server's public address. So the message comes from what the server says afterwards —
  // the same answer the Call Copilot card is drawn from — never from the save alone.
  const handleLink = async () => {
    setSaving(true);
    try {
      let updated: PlivoLine[];
      try {
        updated = await plivoService.saveLine({
          plivoNumber: chosen.plivoNumber,
          userId,
          agentPhone: phone,
          languageCode: chosen.languageCode,
          label: chosen.label,
          active: true,
        });
      } catch (err) {
        toast.error(extractErrorMessage(err));
        return;
      }
      queryClient.setQueryData<PlivoConfig>(['plivo', 'config'], (old) => old && { ...old, lines: updated });

      let status: CallingOverview;
      try {
        status = await queryClient.fetchQuery({
          queryKey: ['calling', 'overview'],
          queryFn: callingService.getOverview,
          staleTime: 0,
        });
      } catch {
        toast('Number saved, but its status could not be checked. Reload the page to see whether you can call.', {
          duration: 8_000,
        });
        return;
      }
      if (status.canCall) {
        toast.success('Number linked to you — you can place calls now.');
      } else if (linkedLine(status)) {
        toast("Number linked to you, but calls can't start yet — see the note on the card.", { duration: 8_000 });
      } else {
        toast.error("The number was saved, but it isn't showing as yours. Reload the page and try again.");
      }
      void queryClient.invalidateQueries({ queryKey: ['plivo'] });
      void queryClient.invalidateQueries({ queryKey: ['calling', 'calls'] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void handleLink();
      }}
    >
      {ordered.length > 1 && (
        <div className={styles.selectField}>
          <label htmlFor="link-line-number">Plivo number</label>
          <select
            id="link-line-number"
            className={styles.select}
            value={chosen.plivoNumber}
            onChange={(e) => setPlivoNumber(e.target.value)}
          >
            {ordered.map((l) => (
              <option key={l.id} value={l.plivoNumber}>
                {formatPhone(l.plivoNumber)} — {l.userName}
              </option>
            ))}
          </select>
        </div>
      )}
      <Input
        label="Your phone"
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="98765 43210"
        hint={`The phone HaiVE rings first when you place a call. +${defaultCountryCode} is assumed if you leave out the country code.`}
        autoComplete="off"
      />
      {otherOwners && (
        <div className={styles.notice} role="note">
          {formatPhone(chosen.plivoNumber)} moves from {chosen.userName} to you — they will stop receiving calls on it.
        </div>
      )}
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onOpenSettings}>
          Calling settings
        </Button>
        <Button type="submit" loading={saving} disabled={phone.replace(/\D/g, '').length < 8}>
          Link to me
        </Button>
      </div>
    </form>
  );
}
