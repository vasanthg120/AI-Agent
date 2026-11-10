import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { CallingCall } from '@/services/callingService';
import { callName, callStatus, callTime } from '../lib/callText';
import { FiInfo, FiPhoneIncoming, FiPhoneMissed, FiPhoneOutgoing } from './icons';
import { ScoreBadge } from './ScoreBadge';
import styles from './CallRow.module.css';

const SWIPE_OPEN = 64;
const SWIPE_MAX = 96;

/**
 * One call in a list. Tapping it calls the number again (or opens it, for
 * someone who can't place calls); the ⓘ button, or a swipe to the left, opens
 * its details. Both are ordinary buttons for keyboards and screen readers.
 */
export function CallRow({
  call,
  onPrimary,
  primaryLabel,
  onDetails,
  busy,
}: {
  call: CallingCall;
  onPrimary: () => void;
  primaryLabel: string;
  onDetails: () => void;
  busy?: boolean;
}) {
  const status = callStatus(call);
  const name = callName(call);
  const time = callTime(call.createdAt);
  const [dx, setDx] = useState(0);
  // The live distance (the state above only draws it): a quick swipe ends
  // before the screen has caught up.
  const travel = useRef(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    start.current = { x: event.clientX, y: event.clientY };
    travel.current = 0;
    swiped.current = false;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!start.current) return;
    const x = event.clientX - start.current.x;
    if (Math.abs(event.clientY - start.current.y) > Math.abs(x)) return;
    if (x < -8) swiped.current = true;
    travel.current = Math.max(-SWIPE_MAX, Math.min(0, x));
    setDx(travel.current);
  };
  const onPointerEnd = () => {
    if (start.current && travel.current <= -SWIPE_OPEN) onDetails();
    start.current = null;
    travel.current = 0;
    setDx(0);
  };

  const Icon = status.tone === 'missed' ? FiPhoneMissed : call.direction === 'inbound' ? FiPhoneIncoming : FiPhoneOutgoing;
  const report = call.report;

  return (
    <li className={styles.item}>
      <span className={styles.reveal} aria-hidden>
        Details
      </span>
      <div
        className={styles.row}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <button
          type="button"
          className={styles.main}
          onClick={() => {
            if (swiped.current) {
              swiped.current = false;
              return;
            }
            onPrimary();
          }}
          aria-label={`${primaryLabel}: ${name}. ${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'}, ${status.label}, ${time}.`}
          aria-busy={busy || undefined}
          disabled={busy}
        >
          <span className={`${styles.icon} ${styles[status.tone]}`} aria-hidden>
            <Icon />
          </span>
          <span className={styles.text}>
            <span className={`${styles.name} ${status.tone === 'missed' ? styles.nameMissed : ''}`}>{name}</span>
            <span className={styles.meta}>
              {status.label}
              {call.customerName ? ` · ${call.customerNumber.length > 4 ? `…${call.customerNumber.slice(-4)}` : ''}` : ''}
            </span>
          </span>
        </button>
        <span className={styles.side}>
          {report?.stage === 'ready' && report.overallScore !== undefined ? (
            <ScoreBadge score={report.overallScore} />
          ) : report && (report.stage === 'transcribing' || report.stage === 'scoring') ? (
            <span className={styles.processing}>Scoring…</span>
          ) : null}
          <span className={styles.time}>{time}</span>
        </span>
        <button type="button" className={styles.info} onClick={onDetails} aria-label={`Details: ${name}`}>
          <FiInfo />
        </button>
      </div>
    </li>
  );
}
