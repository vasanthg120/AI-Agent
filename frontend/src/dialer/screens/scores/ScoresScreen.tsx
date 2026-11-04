import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiAlertTriangle, FiAward, FiChevronRight } from '../../components/icons';
import { ScoreBadge } from '../../components/ScoreBadge';
import { ActionButton, StateScreen } from '../../components/StateScreen';
import { ScreenLoading } from '../../layout/DialerLayout';
import { callName, callTime } from '../../lib/callText';
import { useCalls } from '../../lib/useCalls';
import styles from './ScoresScreen.module.css';

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** How my calls are going: this week in three numbers, then every call that has a report. */
export function ScoresScreen() {
  const navigate = useNavigate();
  const { calls, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useCalls();

  const { week, connected, average, reported } = useMemo(() => {
    const since = Date.now() - WEEK_MS;
    const thisWeek = calls.filter((call) => new Date(call.createdAt).getTime() >= since);
    const scores = thisWeek.map((call) => call.report?.overallScore).filter((score): score is number => score !== undefined);
    return {
      week: thisWeek.length,
      connected: thisWeek.filter((call) => call.outcome?.stage === 'ended').length,
      average: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      reported: calls.filter((call) => call.report),
    };
  }, [calls]);

  if (isLoading) return <ScreenLoading />;
  if (isError && calls.length === 0) {
    return (
      <StateScreen icon={<FiAlertTriangle />} tone="warning" title="Couldn’t load your calls" actions={<ActionButton onClick={() => void refetch()}>Try again</ActionButton>}>
        <p>HaiVE didn’t answer. Check your connection and try again.</p>
      </StateScreen>
    );
  }

  return (
    <div className={styles.screen}>
      <h1 className={styles.title}>Calls &amp; Scores</h1>
      <dl className={styles.tiles} aria-label="The last 7 days">
        <div>
          <dt>Calls · 7 days</dt>
          <dd>{week}</dd>
        </div>
        <div>
          <dt>Connected</dt>
          <dd>{connected}</dd>
        </div>
        <div>
          <dt>Average score</dt>
          <dd>{average === null ? '–' : average.toFixed(1)}</dd>
        </div>
      </dl>

      {reported.length === 0 ? (
        <StateScreen icon={<FiAward />} title="No call reports yet">
          <p>After a call, its transcript, summary, score and coaching tips appear here — usually a minute or two after you hang up.</p>
        </StateScreen>
      ) : (
        <ul className={styles.list}>
          {reported.map((call) => {
            const report = call.report!;
            return (
              <li key={call.id}>
                <button type="button" className={styles.row} onClick={() => navigate(`/report/${call.provider}/${call.id}`)}>
                  <span className={styles.text}>
                    <span className={styles.name}>{callName(call)}</span>
                    <span className={styles.headline}>
                      {report.stage === 'ready'
                        ? (report.headline ?? 'Report ready')
                        : report.stage === 'failed'
                          ? 'The report couldn’t be made'
                          : report.stage === 'scoring'
                            ? 'Scoring…'
                            : 'Transcribing…'}
                    </span>
                  </span>
                  <span className={styles.side}>
                    {report.stage === 'ready' && report.overallScore !== undefined && <ScoreBadge score={report.overallScore} />}
                    <span className={styles.time}>{callTime(call.createdAt)}</span>
                  </span>
                  <FiChevronRight className={styles.chevron} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasNextPage && (
        <button type="button" className={styles.more} onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? 'Loading…' : 'Show older calls'}
        </button>
      )}
    </div>
  );
}
