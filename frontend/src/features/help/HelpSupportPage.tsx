import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiArrowRight,
  FiChevronDown,
  FiCommand,
  FiLifeBuoy,
  FiMessageCircle,
  FiSearch,
  FiSettings,
  FiUsers,
  FiX,
} from 'react-icons/fi';
import { axiosClient } from '@/api/axiosClient';
import { Button, PageHeader } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import { hasRole } from '@/utils/roles';
import { HELP_CATEGORIES, searchArticles, type HelpArticle, type HelpCategory } from './helpContent';
import styles from './HelpSupportPage.module.css';

const POPULAR = ['call a customer abroad', 'reply to emails', 'export a report', 'add a teammate', 'credits'];
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: [MOD, '/'], label: 'Open the command palette — jump to any page' },
  { keys: ['/'], label: 'Search (on this page and in Settings)' },
  { keys: [MOD, 'S'], label: 'Save your profile' },
  { keys: ['Esc'], label: 'Close a dialog or menu' },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Marks each searched word where a word of `text` starts with it ("call" marks
 * "Call" and "calling", not the middle of "automatically"). */
function highlight(text: string, query: string): ReactNode {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map(escapeRegExp);
  if (words.length === 0) return text;
  const parts = text.split(new RegExp(`(?<![\\p{L}\\p{N}])(${words.join('|')})`, 'giu'));
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

type Health = 'checking' | 'ok' | 'down';

function useSystemStatus(): { state: Health; latencyMs?: number } {
  const { data, isError, isLoading } = useQuery({
    queryKey: ['help', 'health'],
    queryFn: async () => {
      const started = performance.now();
      await axiosClient.get('/health');
      return Math.round(performance.now() - started);
    },
    refetchInterval: 60_000,
    retry: 0,
  });
  if (isLoading) return { state: 'checking' };
  if (isError) return { state: 'down' };
  return { state: 'ok', latencyMs: data };
}

function Article({
  article,
  category,
  open,
  query,
  onToggle,
  onGo,
}: {
  article: HelpArticle;
  category?: HelpCategory;
  open: boolean;
  query: string;
  onToggle: () => void;
  onGo: (path: string) => void;
}) {
  return (
    <li className={clsx(styles.article, open && styles.articleOpen)}>
      <button type="button" className={styles.question} aria-expanded={open} onClick={onToggle}>
        <span className={styles.questionText}>
          {category && (
            <span className={styles.questionCategory}>
              <category.icon aria-hidden /> {category.title}
            </span>
          )}
          <span>{highlight(article.question, query)}</span>
        </span>
        <FiChevronDown className={clsx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className={styles.answerWrap}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.9, 0.3, 1] }}
          >
            <div className={styles.answer}>
              <p>{highlight(article.answer, query)}</p>
              {article.link && (
                <button type="button" className={styles.go} onClick={() => onGo(article.link!.path)}>
                  {article.link.label} <FiArrowRight aria-hidden />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

// Help & Support — a small help centre: search every answer at once, browse by
// feature, jump straight to the page where a thing is done, or hand the
// question to HaiVE AI. Answers about settings only admins can open are left
// out for everyone else, so nobody is sent to a page they can't use.
export function HelpSupportPage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const setAssistantPanelOpen = useUiStore((state) => state.setAssistantPanelOpen);
  const setCommandPaletteOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const canManageOrg = hasRole(user, 'owner') || hasRole(user, 'admin');
  const status = useSystemStatus();

  const categories = useMemo(
    () =>
      HELP_CATEGORIES.map((c) => ({ ...c, articles: c.articles.filter((a) => canManageOrg || !a.adminOnly) })).filter(
        (c) => c.articles.length > 0,
      ),
    [canManageOrg],
  );

  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search from anywhere on the page (unless already typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const searching = query.trim().length > 1;
  const hits = useMemo(() => (searching ? searchArticles(query, categories) : []), [searching, query, categories]);
  const category = categories.find((c) => c.id === categoryId) ?? categories[0];

  const toggle = (id: string) => setOpenId((current) => (current === id ? null : id));
  const askAi = () => setAssistantPanelOpen(true);

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiLifeBuoy}
        title="Help & Support"
        subtitle="Answers for every part of HaiVE, a shortcut to the right page, or a question for HaiVE AI."
        actions={
          <Button leftIcon={<FiMessageCircle />} onClick={askAi}>
            Ask HaiVE AI
          </Button>
        }
      />

      <section className={styles.hero} aria-label="Search help">
        <h2 className={styles.heroTitle}>How can we help?</h2>
        <div className={styles.searchBox}>
          <FiSearch className={styles.searchIcon} aria-hidden />
          <input
            ref={searchRef}
            className={styles.searchInput}
            type="search"
            placeholder="Search help — e.g. “call a customer abroad”"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpenId(null);
            }}
            aria-label="Search help"
          />
          {query ? (
            <button type="button" className={styles.clear} onClick={() => setQuery('')} aria-label="Clear search">
              <FiX />
            </button>
          ) : (
            <kbd className={styles.kbdHint}>/</kbd>
          )}
        </div>
        <div className={styles.popular}>
          <span>Popular:</span>
          {POPULAR.map((p) => (
            <button key={p} type="button" className={styles.chip} onClick={() => setQuery(p)}>
              {p}
            </button>
          ))}
        </div>
      </section>

      {searching ? (
        <section className={styles.results} aria-live="polite">
          <div className={styles.resultsHead}>
            {hits.length > 0
              ? `${hits.length} answer${hits.length === 1 ? '' : 's'} for “${query.trim()}”`
              : `No answers for “${query.trim()}”`}
          </div>
          {hits.length > 0 && (
            <ul className={styles.articles}>
              {hits.map(({ article, category: c }) => (
                <Article
                  key={article.id}
                  article={article}
                  category={c}
                  query={query}
                  open={openId === article.id || hits.length === 1}
                  onToggle={() => toggle(article.id)}
                  onGo={navigate}
                />
              ))}
            </ul>
          )}
          <div className={styles.askCard}>
            <FiMessageCircle aria-hidden />
            <div>
              <strong>{hits.length > 0 ? 'Not quite it?' : 'Ask HaiVE AI instead'}</strong>
              <span>HaiVE AI knows your workspace — ask the question in your own words.</span>
            </div>
            <Button variant="secondary" size="sm" onClick={askAi}>
              Ask HaiVE AI
            </Button>
          </div>
        </section>
      ) : (
        <div className={styles.browse}>
          <nav className={styles.categories} aria-label="Help topics">
            {categories.map((c) => {
              const active = c.id === category?.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={clsx(styles.category, active && styles.categoryActive)}
                  aria-current={active || undefined}
                  onClick={() => {
                    setCategoryId(c.id);
                    setOpenId(null);
                  }}
                >
                  {active && (
                    <motion.span
                      layoutId="help-category"
                      className={styles.categoryHighlight}
                      transition={{ duration: 0.2, ease: [0.2, 0.9, 0.3, 1] }}
                    />
                  )}
                  <span className={styles.categoryIcon} aria-hidden>
                    <c.icon />
                  </span>
                  <span className={styles.categoryText}>
                    <span className={styles.categoryTitle}>{c.title}</span>
                    <span className={styles.categoryBlurb}>{c.blurb}</span>
                  </span>
                  <span className={styles.categoryCount}>{c.articles.length}</span>
                </button>
              );
            })}
          </nav>

          {category && (
            <motion.section
              key={category.id}
              className={styles.topic}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18 }}
              aria-label={category.title}
            >
              <header className={styles.topicHead}>
                <span className={styles.topicIcon} aria-hidden>
                  <category.icon />
                </span>
                <div>
                  <h2 className={styles.topicTitle}>{category.title}</h2>
                  <p className={styles.topicBlurb}>{category.blurb}</p>
                </div>
              </header>
              <ul className={styles.articles}>
                {category.articles.map((article) => (
                  <Article
                    key={article.id}
                    article={article}
                    open={openId === article.id}
                    query=""
                    onToggle={() => toggle(article.id)}
                    onGo={navigate}
                  />
                ))}
              </ul>
            </motion.section>
          )}
        </div>
      )}

      <div className={styles.support}>
        <div className={styles.supportCard}>
          <span className={styles.supportIcon} aria-hidden>
            <FiMessageCircle />
          </span>
          <strong>Ask HaiVE AI</strong>
          <p>Instant answers about your deals, customers and documents — and about how to use HaiVE.</p>
          <button type="button" className={styles.go} onClick={askAi}>
            Open the assistant <FiArrowRight aria-hidden />
          </button>
        </div>

        <div className={styles.supportCard}>
          <span className={styles.supportIcon} aria-hidden>
            {canManageOrg ? <FiSettings /> : <FiUsers />}
          </span>
          <strong>{canManageOrg ? 'Manage your workspace' : 'Contact your admin'}</strong>
          <p>
            {canManageOrg
              ? 'Add people, set roles, connect integrations and phone lines, and control billing from Settings.'
              : 'Your workspace owner or admin can add teammates, change permissions, connect integrations and manage billing.'}
          </p>
          {canManageOrg && (
            <button type="button" className={styles.go} onClick={() => navigate(ROUTES.settings)}>
              Open Settings <FiArrowRight aria-hidden />
            </button>
          )}
        </div>

        <div className={styles.supportCard}>
          <span className={styles.supportIcon} aria-hidden>
            <FiCommand />
          </span>
          <strong>Keyboard shortcuts</strong>
          <ul className={styles.shortcuts}>
            {SHORTCUTS.map((s) => (
              <li key={s.label}>
                <span className={styles.keys}>
                  {s.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
                <span>{s.label}</span>
              </li>
            ))}
          </ul>
          <button type="button" className={styles.go} onClick={() => setCommandPaletteOpen(true)}>
            Try the command palette <FiArrowRight aria-hidden />
          </button>
        </div>

        <div className={styles.supportCard}>
          <span className={clsx(styles.statusDot, styles[`status_${status.state}`])} aria-hidden />
          <strong>System status</strong>
          <p role="status">
            {status.state === 'checking'
              ? 'Checking…'
              : status.state === 'ok'
                ? `All systems working · responding in ${status.latencyMs} ms`
                : 'HaiVE can’t reach its server right now. Check your connection; if it persists, tell your admin.'}
          </p>
          <span className={styles.statusNote}>Checked every minute while this page is open.</span>
        </div>
      </div>
    </div>
  );
}
