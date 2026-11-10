import { useNavigate } from 'react-router-dom';
import { PROVIDER_LABEL, type CallingCall } from '@/services/callingService';
import { callName, callStatus, duration } from '../lib/callText';
import { formatNumber } from '../lib/dialRules';
import { FiEdit, FiFileText, FiPhone } from './icons';
import { ScoreBadge } from './ScoreBadge';
import { Sheet } from './Sheet';
import styles from './CallDetailsSheet.module.css';

function resultOf(call: CallingCall): string {
  if (call.outcome?.stage === 'failed') return call.outcome.message;
  if (call.outcome?.stage === 'ended') return call.durationSeconds ? `Connected · ${duration(call.durationSeconds)}` : 'Connected';
  return callStatus(call).label;
}

/** Everything about one call, and what can be done with it. */
export function CallDetailsSheet({
  call,
  onClose,
  canPlace,
  onCall,
  placing,
}: {
  call: CallingCall | null;
  onClose: () => void;
  canPlace: boolean;
  onCall: (call: CallingCall) => void;
  placing?: boolean;
}) {
  const navigate = useNavigate();
  const report = call?.report;
  return (
    <Sheet open={!!call} onClose={onClose} title={call ? callName(call) : ''}>
      {call && (
        <div className={styles.body}>
          <dl className={styles.facts}>
            <div>
              <dt>Number</dt>
              <dd>{formatNumber(call.customerNumber)}</dd>
            </div>
            <div>
              <dt>When</dt>
              <dd>{new Date(call.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>{resultOf(call)}</dd>
            </div>
            <div>
              <dt>Line</dt>
              <dd>
                {call.direction === 'inbound' ? 'Incoming' : 'Outgoing'} · {PROVIDER_LABEL[call.provider]} · {formatNumber(call.businessNumber)}
              </dd>
            </div>
            {report && (
              <div>
                <dt>Report</dt>
                <dd className={styles.report}>
                  {report.stage === 'ready' ? (report.overallScore !== undefined ? <ScoreBadge score={report.overallScore} /> : 'Ready') : report.stage === 'failed' ? 'Couldn’t be made' : 'Being made…'}
                  {report.headline && <span>{report.headline}</span>}
                </dd>
              </div>
            )}
          </dl>
          <div className={styles.actions}>
            {(report || call.importStatus !== 'none' || call.outcome?.stage === 'ended') && (
              <button type="button" className={styles.secondary} onClick={() => navigate(`/report/${call.provider}/${call.id}`)}>
                <FiFileText /> {report?.stage === 'ready' ? 'View report' : 'Report progress'}
              </button>
            )}
            {canPlace && (
              <>
                <button type="button" className={styles.call} onClick={() => onCall(call)} disabled={placing} aria-busy={placing || undefined}>
                  <FiPhone /> {placing ? 'Calling…' : 'Call'}
                </button>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => navigate('/', { state: { number: `+${call.customerNumber}`, customerName: call.customerName, dealId: call.dealId } })}
                >
                  <FiEdit /> Change the number first
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
