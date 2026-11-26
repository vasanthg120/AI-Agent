import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import dayjs from 'dayjs';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  FiActivity,
  FiAlertTriangle,
  FiArrowRight,
  FiAward,
  FiBarChart2,
  FiCheckCircle,
  FiFrown,
  FiHelpCircle,
  FiHome,
  FiMeh,
  FiMic,
  FiMinus,
  FiPhoneCall,
  FiRefreshCw,
  FiSmile,
  FiStar,
  FiTarget,
  FiTrendingDown,
  FiTrendingUp,
  FiUploadCloud,
  FiUser,
  FiUsers,
} from 'react-icons/fi';
import { Button, DateRangeControl, EmptyState, SelectMenu, Skeleton, Spinner, StatTile } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { extractErrorMessage } from '@/utils/errors';
import {
  callCopilotService,
  hasCoachingReport,
  type CallPerformance,
  type CallSessionDetail,
  type CallTeamInfo,
  type PerformanceCallItem,
  type PerformanceCategory,
  type PerformanceListKey,
  type PersonPerformance,
} from '@/services/callCopilotService';
import { formatCallDate } from '../callMeta';
import { FADE_UP, staggerChildren } from '../motion';
import { CallSessionViewer } from './CallSessionViewer';
import { CallSummaryModal } from './CallSummaryModal';
import libraryStyles from './CallLibraryListView.module.css';
import styles from './PerformanceView.module.css';

// The Performance tab: what the AI Coach's reviews say about you — or, for an
// owner, admin, manager or the Main Account owner, about the team — over a
// period. Every figure comes from reviews already saved on the calls
// (backend call-performance.ts); nothing here asks the AI anything. People with
// too few reviewed calls are shown but never ranked or labelled.

const DAY = 'YYYY-MM-DD';
// Exactly the date control's own "30 Days" preset, so it shows as chosen.
const last30 = (): DateRange => ({ dateFrom: dayjs().subtract(30, 'day').format(DAY), dateTo: dayjs().format(DAY) });

function toQueryRange(range: DateRange): { dateFrom?: string; dateTo?: string } {
  return {
    dateFrom: range.dateFrom ? dayjs(range.dateFrom).startOf('day').toISOString() : undefined,
    dateTo: range.dateTo ? dayjs(range.dateTo).endOf('day').toISOString() : undefined,
  };
}

const KIND_OPTIONS = [
  { value: 'live', label: 'Live calls' },
  { value: 'phone', label: 'Phone calls' },
  { value: 'upload', label: 'Uploaded recordings' },
];
const SCORE_OPTIONS = [
  { value: 'good', label: 'Good (7+)' },
  { value: 'fair', label: 'Fair (5–7)' },
  { value: 'low', label: 'Low (under 5)' },
];

const LISTS: { key: PerformanceListKey; label: string; empty: string }[] = [
  { key: 'attention', label: 'Needs attention', empty: 'No call scored under 5 or raised a serious concern.' },
  { key: 'top', label: 'Top calls', empty: 'No call scored 7 or more in this period.' },
  { key: 'negative', label: 'Negative customer', empty: 'No customer ended a call negative.' },
  { key: 'unresolved', label: 'Unresolved', empty: 'Every customer question and objection was dealt with.' },
  { key: 'noFollowUp', label: 'No follow-up', empty: 'Every call closed with a follow-up.' },
  { key: 'recent', label: 'Recent', empty: 'No reviewed calls yet.' },
];

const SENTIMENT_ROWS: { key: keyof CallPerformance['overview']['sentiment']; label: string; icon: ReactNode }[] = [
  { key: 'positive', label: 'Positive', icon: <FiSmile /> },
  { key: 'neutral', label: 'Neutral', icon: <FiMeh /> },
  { key: 'mixed', label: 'Mixed', icon: <FiActivity /> },
  { key: 'negative', label: 'Negative', icon: <FiFrown /> },
  { key: 'unclear', label: 'Unclear', icon: <FiHelpCircle /> },
];

const KIND_ICON = { live: <FiMic />, phone: <FiPhoneCall />, upload: <FiUploadCloud /> };

const score10 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}/10`);
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;

export function PerformanceView() {
  const navigate = useNavigate();
  const [team, setTeam] = useState<CallTeamInfo | null>(null);
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [business, setBusiness] = useState('all');
  const [department, setDepartment] = useState('');
  const [person, setPerson] = useState('');
  const [range, setRange] = useState<DateRange>(last30);
  const [kind, setKind] = useState('');
  const [score, setScore] = useState('');
  const [data, setData] = useState<CallPerformance | null>(null);
  // The same team without the person filter: what one person is compared with.
  const [baseline, setBaseline] = useState<CallPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState<PerformanceListKey>('attention');
  const [selected, setSelected] = useState<CallSessionDetail | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [trendAsTable, setTrendAsTable] = useState(false);

  useEffect(() => {
    callCopilotService
      .getTeam()
      .then((info) => {
        setTeam(info);
        // Someone who can see the team comes here for the team.
        if (info.team) setScope('team');
      })
      .catch(() => setTeam(null));
  }, []);

  const teamFilter = scope === 'team' ? { scope: 'team' as const, organizationId: business === 'all' ? undefined : business } : {};
  const filters = { ...toQueryRange(range), ...teamFilter, kind: (kind || undefined) as never, score: (score || undefined) as never, department: scope === 'team' && department ? department : undefined };
  const key = JSON.stringify([filters, person, reload]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    const onePerson = scope === 'team' && person;
    Promise.all([
      callCopilotService.getPerformance({ ...filters, userId: onePerson ? person : undefined }),
      onePerson ? callCopilotService.getPerformance(filters) : Promise.resolve(null),
    ])
      .then(([result, team]) => {
        if (stale) return;
        setData(result);
        setBaseline(team);
      })
      .catch((err) => {
        if (!stale) setError(extractErrorMessage(err));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
    // `key` stands for every filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const openCall = async (id: string, mine: boolean) => {
    if (!mine) {
      setViewing(id);
      return;
    }
    setOpening(id);
    try {
      setSelected(await callCopilotService.getSession(id));
    } catch {
      toast.error("Couldn't open that call. Please try again.");
    } finally {
      setOpening(null);
    }
  };

  const businessOptions = [{ value: 'all', label: 'All businesses' }, ...(team?.businesses ?? []).map((b) => ({ value: b.id, label: b.name }))];
  const departments = useMemo(
    () => [...new Set((team?.people ?? []).filter((p) => business === 'all' || p.businessId === business).map((p) => p.department).filter((d): d is string => !!d))].sort(),
    [team, business],
  );
  const personOptions = (team?.people ?? [])
    .filter((p) => (business === 'all' || p.businessId === business) && (!department || p.department === department))
    .map((p) => ({ value: p.id, label: p.name, hint: team?.acrossBusinesses ? team.businesses.find((b) => b.id === p.businessId)?.name : undefined }));

  // One person's view: yours ("My calls"), or the person picked from the team.
  const profile: PersonPerformance | null =
    data && (scope === 'mine' ? data.people[0] ?? null : person ? (data.people.find((p) => p.userId === person) ?? null) : null);
  const overview = data?.overview;
  const nothing = !!data && data.overview.analysed === 0;
  const first = loading && !data;

  return (
    <div className={styles.wrapper}>
      {/* ---- filters: one row above everything they scope ---- */}
      <div className={styles.filters}>
        {team?.team && (
          <div className={libraryStyles.scopeToggle} role="radiogroup" aria-label="Whose calls">
            {(['mine', 'team'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                className={clsx(libraryStyles.scopeOption, scope === value && libraryStyles.scopeOptionActive)}
                onClick={() => {
                  setScope(value);
                  setPerson('');
                }}
              >
                {value === 'mine' ? <FiUser aria-hidden /> : <FiUsers aria-hidden />}
                {value === 'mine' ? 'My calls' : team.acrossBusinesses ? 'All businesses' : 'Team'}
              </button>
            ))}
          </div>
        )}
        <DateRangeControl value={range} onChange={setRange} presets={['7', '30', '90', 'month', 'lastMonth', 'quarter', 'year', 'all', 'custom']} />
      </div>
      <div className={styles.filters}>
        {scope === 'team' && team?.acrossBusinesses && (
          <SelectMenu
            value={business}
            options={businessOptions}
            onChange={(v) => {
              setBusiness(v);
              setDepartment('');
              setPerson('');
            }}
            ariaLabel="Business"
            icon={<FiHome aria-hidden />}
            size="sm"
            className={styles.picker}
          />
        )}
        {scope === 'team' && departments.length > 0 && (
          <SelectMenu
            value={department}
            options={departments.map((d) => ({ value: d, label: d }))}
            emptyOption="Every team"
            onChange={(v) => {
              setDepartment(v);
              setPerson('');
            }}
            ariaLabel="Team"
            size="sm"
            className={styles.picker}
          />
        )}
        {scope === 'team' && (
          <SelectMenu value={person} options={personOptions} emptyOption="Everyone" onChange={setPerson} ariaLabel="Person" avatars size="sm" className={styles.picker} />
        )}
        <SelectMenu value={kind} options={KIND_OPTIONS} emptyOption="Every kind of call" onChange={setKind} ariaLabel="Kind of call" size="sm" className={styles.picker} />
        <SelectMenu value={score} options={SCORE_OPTIONS} emptyOption="Any score" onChange={setScore} ariaLabel="Score" size="sm" className={styles.picker} />
        {loading && data && <Spinner size={16} />}
      </div>

      {error && (
        <div className={styles.error} role="alert">
          <FiAlertTriangle aria-hidden /> <span>{error}</span>
          <Button type="button" size="sm" variant="secondary" leftIcon={<FiRefreshCw />} onClick={() => setReload((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}

      {first ? (
        <div className={styles.kpis}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={92} />
          ))}
        </div>
      ) : data && overview ? (
        <motion.div className={clsx(styles.body, loading && styles.refreshing)} variants={staggerChildren(0.05)} initial="hidden" animate="show">
          {/* ---- the headline figures ---- */}
          <motion.div className={styles.kpis} variants={FADE_UP}>
            <StatTile icon={FiBarChart2} value={overview.analysed} label={`Calls reviewed · of ${overview.calls}`} />
            <StatTile
              icon={FiAward}
              value={score10(overview.averageScore)}
              label="Average score"
              trend={overview.change !== null && overview.change !== 0 ? { direction: overview.change > 0 ? 'up' : 'down', label: `${signed(overview.change)} vs last period` } : undefined}
              sparkline={overview.trend.map((t) => t.averageScore).filter((v): v is number => v !== null)}
            />
            <StatTile
              icon={FiCheckCircle}
              value={overview.successful}
              label={overview.successRate === null ? 'Successful calls' : `Successful calls · ${overview.successRate}% of outcomes`}
            />
            {scope === 'team' && !person ? (
              <>
                <StatTile icon={FiStar} value={overview.highPerformers} label={`High performers (avg 7+, ${data.limits.minCallsToRank}+ calls)`} />
                <StatTile icon={FiTarget} value={overview.needCoaching} label="Need coaching (avg under 5)" />
              </>
            ) : (
              <StatTile
                icon={FiSmile}
                value={overview.analysed ? `${Math.round((overview.sentiment.positive / overview.analysed) * 100)}%` : '—'}
                label="Customers ending positive"
              />
            )}
          </motion.div>

          {data.limits.capped && <p className={styles.note}>Only the newest 3,000 calls of this period are counted — pick a shorter period for exact figures.</p>}

          {nothing ? (
            <EmptyState
              icon={FiBarChart2}
              title="No reviewed calls in this period"
              description="Calls appear here once the AI Coach has reviewed them. Try a longer period or clear a filter."
              action={
                <Button type="button" variant="secondary" size="sm" onClick={() => setRange({})}>
                  Show all time
                </Button>
              }
            />
          ) : (
            <>
              {/* ---- over time, and how customers felt ---- */}
              <motion.div className={styles.row} variants={FADE_UP}>
                <section className={styles.card}>
                  <header className={styles.cardHead}>
                    <h4>Average score over time</h4>
                    <button type="button" className={styles.linkButton} onClick={() => setTrendAsTable((v) => !v)}>
                      {trendAsTable ? 'Chart' : 'Table'}
                    </button>
                  </header>
                  {trendAsTable ? <TrendTable points={(profile ?? data.overview).trend} /> : <TrendChart points={(profile ?? data.overview).trend} />}
                </section>
                <section className={styles.card}>
                  <header className={styles.cardHead}>
                    <h4>How customers felt at the end</h4>
                  </header>
                  <ul className={styles.bars}>
                    {SENTIMENT_ROWS.map((row) => {
                      const n = overview.sentiment[row.key];
                      const share = overview.analysed ? n / overview.analysed : 0;
                      return (
                        <li key={row.key} className={styles.barRow}>
                          <span className={styles.barLabel}>
                            <span className={styles.barIcon} aria-hidden>
                              {row.icon}
                            </span>
                            {row.label}
                          </span>
                          <span className={styles.track}>
                            <span className={styles.fill} style={{ width: `${share * 100}%` }} />
                          </span>
                          <span className={styles.barValue}>
                            {n} <small>{Math.round(share * 100)}%</small>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </motion.div>

              {/* ---- one person ---- */}
              {profile && (
                <PersonProfile
                  person={profile}
                  team={scope === 'team' ? (baseline ?? null) : null}
                  minCalls={data.limits.minCallsToRank}
                  showActivityLink={scope === 'team' && profile.sameBusiness}
                  onActivity={() => navigate(ROUTES.employeeProfileOf(profile.userId))}
                  onOpenCall={(id) => void openCall(id, profile.isViewer)}
                />
              )}

              {/* ---- skills ---- */}
              <motion.section className={styles.card} variants={FADE_UP}>
                <header className={styles.cardHead}>
                  <h4>Skill averages</h4>
                  <span className={styles.hint}>Out of 10, from every reviewed call</span>
                </header>
                <SkillBars categories={profile ? profile.categories : data.categories} compareWith={profile && baseline ? baseline.categories : null} name={profile?.name} />
              </motion.section>

              {/* ---- the team ---- */}
              {scope === 'team' && !person && data.people.length > 0 && (
                <motion.section className={styles.card} variants={FADE_UP}>
                  <header className={styles.cardHead}>
                    <h4>People</h4>
                    <span className={styles.hint}>Ranked by average score · {data.limits.minCallsToRank}+ reviewed calls to be ranked</span>
                  </header>
                  <div className={styles.people}>
                    <div className={clsx(styles.personRow, styles.personHead)} aria-hidden>
                      <span>#</span>
                      <span>Person</span>
                      <span>Calls</span>
                      <span>Average</span>
                      <span>Change</span>
                      <span>Customers positive</span>
                      <span>Successful</span>
                      <span>Standing</span>
                    </div>
                    <ul className={styles.peopleList} aria-label="People ranked by average call score">
                      {data.people.map((p) => (
                        <li key={`${p.organizationId}|${p.userId}`}>
                          <button
                            type="button"
                            className={styles.personRow}
                            onClick={() => setPerson(p.userId)}
                            aria-label={`${p.name}: ${p.rank ? `ranked ${p.rank}, ` : ''}average ${score10(p.averageScore)} over ${p.analysed} reviewed calls. Open their profile.`}
                          >
                            <span className={styles.rank}>{p.rank ?? '–'}</span>
                            <span className={styles.personName}>
                              <strong>{p.name}</strong>
                              {p.businessName && team?.acrossBusinesses && <small>{p.businessName}</small>}
                            </span>
                            <span data-label="Calls">
                              {p.analysed}
                              {p.calls > p.analysed && <small> of {p.calls}</small>}
                            </span>
                            <span data-label="Average" className={styles.strong}>
                              {score10(p.averageScore)}
                            </span>
                            <span data-label="Change">
                              <Direction person={p} />
                            </span>
                            <span data-label="Customers positive">{p.satisfaction === null ? '—' : `${p.satisfaction}%`}</span>
                            <span data-label="Successful">{p.successRate === null ? '—' : `${p.successRate}%`}</span>
                            <span>
                              <Standing person={p} minCalls={data.limits.minCallsToRank} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </motion.section>
              )}

              {/* ---- calls worth opening ---- */}
              <motion.section className={styles.card} variants={FADE_UP}>
                <header className={styles.cardHead}>
                  <h4>Calls</h4>
                </header>
                <div className={styles.listTabs} role="tablist" aria-label="Which calls">
                  {LISTS.map((l) => (
                    <button
                      key={l.key}
                      type="button"
                      role="tab"
                      aria-selected={list === l.key}
                      className={clsx(styles.listTab, list === l.key && styles.listTabActive)}
                      onClick={() => setList(l.key)}
                    >
                      {l.label}
                      <span className={styles.count}>{data.lists[l.key].length}</span>
                    </button>
                  ))}
                </div>
                <CallList
                  items={data.lists[list]}
                  empty={LISTS.find((l) => l.key === list)!.empty}
                  showOwner={scope === 'team'}
                  opening={opening}
                  onOpen={(item) => void openCall(item.id, item.mine)}
                />
              </motion.section>
            </>
          )}
        </motion.div>
      ) : null}

      <CallSessionViewer sessionId={viewing} onClose={() => setViewing(null)} />
      {selected && (
        <CallSummaryModal
          open
          onClose={() => setSelected(null)}
          source={selected.source}
          originalFilename={selected.originalFilename}
          summaryResult={selected}
          segments={selected.transcript}
          sessionId={selected._id}
          createdAt={selected.source === 'live' ? selected.createdAt : undefined}
          sentiment={selected.sentiment}
          coaching={hasCoachingReport(selected) ? selected : undefined}
          onCoachingGenerated={(report) => setSelected((prev) => (prev ? { ...prev, ...report } : prev))}
        />
      )}
    </div>
  );
}

// ---- pieces ----

function Direction({ person }: { person: PersonPerformance }) {
  if (person.direction === null || person.change === null) return <span className={styles.muted}>—</span>;
  const Icon = person.direction === 'improving' ? FiTrendingUp : person.direction === 'declining' ? FiTrendingDown : FiMinus;
  return (
    <span className={clsx(styles.direction, styles[`dir_${person.direction}`])} title={`Previous period: ${score10(person.previousAverage)}`}>
      <Icon aria-hidden /> {person.direction === 'steady' ? 'Steady' : signed(person.change)}
    </span>
  );
}

function Standing({ person, minCalls }: { person: PersonPerformance; minCalls: number }) {
  const meta = {
    high: { label: 'High performer', icon: <FiStar />, tone: 'good' },
    coaching: { label: 'Needs coaching', icon: <FiTarget />, tone: 'warn' },
    steady: { label: 'Steady', icon: <FiMinus />, tone: 'plain' },
    too_few: { label: `Needs ${minCalls} reviewed calls`, icon: <FiHelpCircle />, tone: 'muted' },
  }[person.standing];
  return (
    <span className={clsx(styles.badge, styles[`badge_${meta.tone}`])}>
      <span aria-hidden>{meta.icon}</span>
      {meta.label}
    </span>
  );
}

function TrendChart({ points }: { points: CallPerformance['overview']['trend'] }) {
  const shown = points.filter((p) => p.calls > 0).length;
  if (shown === 0) return <p className={styles.muted}>No reviewed calls in this period.</p>;
  const interval = Math.max(0, Math.ceil(points.length / 6) - 1);
  return (
    <div className={styles.chart}>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points} margin={{ top: 8, right: 36, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="label" stroke="var(--color-text-muted)" fontSize={11} axisLine={false} tickLine={false} interval={interval} />
          <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} stroke="var(--color-text-muted)" fontSize={11} axisLine={false} tickLine={false} />
          <Tooltip content={<TrendTip />} cursor={{ stroke: 'var(--color-border-strong)', strokeWidth: 1 }} />
          <Line
            type="monotone"
            dataKey="averageScore"
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-bg-surface)', fill: 'var(--color-accent)' }}
            activeDot={{ r: 6, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
            // A period with no calls has no point; the line runs on to the next one that has.
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendTip({ active, payload }: { active?: boolean; payload?: { payload: CallPerformance['overview']['trend'][number] }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className={styles.tip}>
      <strong>{score10(p.averageScore)}</strong>
      <span>
        {p.label} · {p.calls} call{p.calls === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function TrendTable({ points }: { points: CallPerformance['overview']['trend'] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Period</th>
            <th>Calls</th>
            <th>Average</th>
          </tr>
        </thead>
        <tbody>
          {points
            .filter((p) => p.calls > 0)
            .map((p) => (
              <tr key={p.start}>
                <td>{p.label}</td>
                <td>{p.calls}</td>
                <td>{score10(p.averageScore)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function SkillBars({ categories, compareWith, name }: { categories: PerformanceCategory[]; compareWith: PerformanceCategory[] | null; name?: string }) {
  if (categories.length === 0) return <p className={styles.muted}>No skill scores yet — these come from calls reviewed since the nine-skill scorecard (November 2026).</p>;
  const team = new Map((compareWith ?? []).map((c) => [c.key, c.average]));
  return (
    <>
      {compareWith && (
        <div className={styles.legend} aria-hidden>
          <span>
            <i className={styles.legendBar} /> {name}
          </span>
          <span>
            <i className={styles.legendTick} /> Team average
          </span>
        </div>
      )}
      <ul className={styles.bars}>
        {categories.map((c) => {
          const t = team.get(c.key);
          return (
            <li key={c.key} className={clsx(styles.barRow, styles.skillRow)} title={`${c.label}: ${c.average}/10 over ${c.calls} call${c.calls === 1 ? '' : 's'}${t !== undefined ? ` · team ${t}/10` : ''}`}>
              <span className={styles.barLabel}>{c.label}</span>
              <span className={styles.track}>
                <span className={styles.fill} style={{ width: `${c.average * 10}%` }} />
                {t !== undefined && <span className={styles.tick} style={{ left: `${t * 10}%` }} />}
              </span>
              <span className={styles.barValue}>
                {c.average}
                {t !== undefined && <small> team {t}</small>}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function PersonProfile({
  person,
  team,
  minCalls,
  showActivityLink,
  onActivity,
  onOpenCall,
}: {
  person: PersonPerformance;
  team: CallPerformance | null;
  minCalls: number;
  showActivityLink: boolean;
  onActivity: () => void;
  onOpenCall: (id: string) => void;
}) {
  return (
    <motion.section className={clsx(styles.card, styles.profile)} variants={FADE_UP}>
      <header className={styles.profileHead}>
        <div>
          <h4>{person.name}</h4>
          <span className={styles.hint}>
            {person.analysed} reviewed call{person.analysed === 1 ? '' : 's'}
            {person.rank !== null && ` · ranked ${person.rank} of ${team?.people.filter((p) => p.rank !== null).length ?? 1}`}
            {team?.overview.averageScore !== null && team && ` · team average ${score10(team.overview.averageScore)}`}
          </span>
        </div>
        <div className={styles.profileScore}>
          <strong>{score10(person.averageScore)}</strong>
          <Direction person={person} />
          <Standing person={person} minCalls={minCalls} />
        </div>
        {showActivityLink && (
          <Button type="button" size="sm" variant="ghost" rightIcon={<FiArrowRight />} onClick={onActivity}>
            Employee Activity
          </Button>
        )}
      </header>
      <div className={styles.profileGrid}>
        <div>
          <h5>
            <FiCheckCircle aria-hidden /> Strengths
          </h5>
          {person.strengths.length ? (
            <ul className={styles.points}>
              {person.strengths.map((s) => (
                <li key={s.key}>
                  {s.label} <b>{s.average}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>No skill averages 7 or more yet.</p>
          )}
        </div>
        <div>
          <h5>
            <FiTarget aria-hidden /> Coaching focus
          </h5>
          {person.focus.length ? (
            <ul className={styles.points}>
              {person.focus.map((f) => (
                <li key={f.key}>
                  {f.label} <b>{f.average}</b>
                  <small>{f.training}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>Every skill averages 7 or more.</p>
          )}
        </div>
        <div>
          <h5>
            <FiAlertTriangle aria-hidden /> Happens again and again
          </h5>
          {person.recurring.length ? (
            <ul className={styles.points}>
              {person.recurring.map((r) => (
                <li key={r.kind}>
                  {r.label} <b>{r.count} calls</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>No missed opportunity on two or more calls.</p>
          )}
        </div>
        <div>
          <h5>
            <FiAward aria-hidden /> Recognition
          </h5>
          {person.recognition.length ? (
            <ul className={styles.points}>
              {person.recognition.map((r) => (
                <li key={r.sessionId}>
                  <button type="button" className={styles.linkButton} onClick={() => onOpenCall(r.sessionId)}>
                    {r.score}/10 · {dayjs(r.createdAt).format('D MMM')}
                  </button>{' '}
                  {r.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>No call scored 8 or more in this period.</p>
          )}
        </div>
      </div>
    </motion.section>
  );
}

function CallList({
  items,
  empty,
  showOwner,
  opening,
  onOpen,
}: {
  items: PerformanceCallItem[];
  empty: string;
  showOwner: boolean;
  opening: string | null;
  onOpen: (item: PerformanceCallItem) => void;
}) {
  if (items.length === 0) return <p className={styles.muted}>{empty}</p>;
  return (
    <ul className={styles.calls}>
      {items.map((c) => (
        <li key={c.id}>
          <button type="button" className={styles.callRow} onClick={() => onOpen(c)}>
            <span className={styles.callKind} aria-hidden>
              {KIND_ICON[c.kind]}
            </span>
            <span className={styles.callText}>
              <strong>{c.headline}</strong>
              <small>
                {showOwner && `${c.ownerName}${c.businessName ? ` · ${c.businessName}` : ''} · `}
                {formatCallDate(c.createdAt)}
              </small>
              {c.reasons.length > 0 && <span className={styles.reasons}>{c.reasons.join(' · ')}</span>}
            </span>
            {opening === c.id ? <Spinner size={16} /> : <span className={clsx(styles.scoreChip, c.score !== null && c.score < 5 && styles.scoreLow)}>{score10(c.score)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
