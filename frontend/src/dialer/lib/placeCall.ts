import { useRef, useState } from 'react';
import axios from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { callingService, type StartRefusal } from '@/services/callingService';
import { extractErrorMessage } from '@/utils/errors';
import { haptic } from './haptics';

const MESSAGES: Partial<Record<StartRefusal | 'forbidden' | 'network', string>> = {
  network: 'Couldn’t reach HaiVE. Check your connection and try again.',
  forbidden: 'You can see calls but not place them. Ask an administrator for permission to place calls.',
  own_number: 'That’s your own number. Enter the customer’s number.',
  no_line: 'You don’t have a phone line yet. Ask an administrator to link one to you in Settings → Calling.',
  not_ready: 'Calling isn’t fully set up yet. Ask an administrator to check Settings → Calling.',
  call_in_progress: 'A call is already being set up. Answer your phone, or wait a minute and try again.',
  balance: 'There isn’t enough calling balance. Ask an administrator to top up the phone account.',
  offline: 'Calling is offline: the phone system can’t reach HaiVE right now. Ask an administrator to check calling.',
};

/** A refused start, in plain words: the server's own sentence where it is already plain. */
export function refusalMessage(err: unknown): { code: StartRefusal | 'forbidden' | 'network' | 'unknown'; message: string } {
  if (axios.isAxiosError(err)) {
    if (!err.response) return { code: 'network', message: MESSAGES.network! };
    if (err.response.status === 403) return { code: 'forbidden', message: MESSAGES.forbidden! };
    const code = (err.response.data as { code?: StartRefusal } | undefined)?.code;
    if (code) return { code, message: MESSAGES[code] ?? extractErrorMessage(err) };
  }
  return { code: 'unknown', message: extractErrorMessage(err) };
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface PlaceCallInput {
  // Digits with country code, no "+".
  digits: string;
  customerName?: string;
  dealId?: string;
  // Replace the current screen (calling again from the call screen).
  replace?: boolean;
}

/**
 * Starts a call and opens its live screen. One tap is one call: a second tap
 * while the first is on its way is ignored here, and a retry after a lost
 * connection sends the same request key, so the server returns the call it
 * already started instead of ringing the phone twice.
 */
export function usePlaceCall() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [placing, setPlacing] = useState(false);
  const busy = useRef(false);
  const pending = useRef<{ digits: string; key: string } | null>(null);

  const place = async ({ digits, customerName, dealId, replace }: PlaceCallInput): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
    if (busy.current) return { ok: false, code: 'busy', message: '' };
    busy.current = true;
    setPlacing(true);
    if (pending.current?.digits !== digits) pending.current = { digits, key: newKey() };
    try {
      const call = await callingService.startCall(`+${digits}`, { requestKey: pending.current.key, dealId, customerName });
      pending.current = null;
      haptic('start');
      void queryClient.invalidateQueries({ queryKey: ['dialer', 'calls'] });
      navigate(`/call/${call.provider}/${call.id}`, { state: { call }, replace });
      return { ok: true };
    } catch (err) {
      const refusal = refusalMessage(err);
      // Only a lost connection may be retried as the same call.
      if (refusal.code !== 'network') pending.current = null;
      haptic('error');
      return { ok: false, ...refusal };
    } finally {
      busy.current = false;
      setPlacing(false);
    }
  };
  return { place, placing };
}
