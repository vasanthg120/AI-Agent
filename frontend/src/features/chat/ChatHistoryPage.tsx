import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import {
  FiPlus,
  FiSearch,
  FiBookmark,
  FiStar,
  FiArchive,
  FiMoreHorizontal,
  FiEdit2,
  FiTrash2,
  FiMessageSquare,
  FiArrowLeft,
  FiArrowRight,
  FiAlertTriangle,
  FiInbox,
} from 'react-icons/fi';
import { Button, Card, Dropdown, EmptyState, Input, Modal, PageHeader, StatTile } from '@/components/ui';
import { useChatStore } from '@/stores/chatStore';
import { ROUTES } from '@/constants/routes';
import { formatRelativeTime, getConversationGroup, CONVERSATION_GROUP_LABELS, type ConversationGroupKey } from '@/utils/date';
import type { ChatMessage, Conversation } from '@/types';
import { MessageList } from './components/MessageList';
import styles from './ChatHistoryPage.module.css';

// Stable reference — same reasoning as ChatPage.tsx's identical constant: a
// selector that returns a fresh [] literal every time there's no active
// conversation defeats useSyncExternalStore's identity check and causes an
// infinite render loop, since every render sees "a new array" as a change.
const EMPTY_MESSAGES: ChatMessage[] = [];

const GROUP_ORDER: ConversationGroupKey[] = ['today', 'yesterday', 'lastWeek', 'older'];

// Wraps every case-insensitive occurrence of `query` in <mark>, so search
// results show *why* they matched.
function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
    at = lower.indexOf(needle, from);
  }
  parts.push(text.slice(from));
  return parts;
}

// Master-detail layout — a list on the left, the selected conversation's
// full thread rendered inline on the right (reusing MessageList, the SAME
// component ChatPage.tsx uses, so formatting/tool badges/etc. all match
// exactly). Viewing a conversation here no longer requires navigating away
// to /chat/:id at all; "Continue in Chat" is the one explicit action that
// does that, for actually sending a new message into it.
export function ChatHistoryPage() {
  const conversations = useChatStore((state) => state.conversations);
  const filter = useChatStore((state) => state.filter);
  const setFilter = useChatStore((state) => state.setFilter);
  const searchQuery = useChatStore((state) => state.searchQuery);
  const setSearchQuery = useChatStore((state) => state.setSearchQuery);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const toggleConversationFlag = useChatStore((state) => state.toggleConversationFlag);
  const renameConversation = useChatStore((state) => state.renameConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const startNewConversation = useChatStore((state) => state.startNewConversation);

  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const messages = useChatStore((state) => (activeConversationId ? (state.messages[activeConversationId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES));

  const navigate = useNavigate();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDetailOnMobile, setShowDetailOnMobile] = useState(false);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const stats = useMemo(
    () => ({
      // "All" hides archived conversations (see `filtered` below), so its
      // tile counts the same set it shows.
      total: conversations.filter((c) => !c.archived).length,
      pinned: conversations.filter((c) => c.pinned).length,
      favorites: conversations.filter((c) => c.favorite).length,
      archived: conversations.filter((c) => c.archived).length,
    }),
    [conversations],
  );

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      if (filter === 'pinned' && !c.pinned) return false;
      if (filter === 'favorites' && !c.favorite) return false;
      if (filter === 'archived') {
        if (!c.archived) return false;
      } else if (c.archived) {
        return false;
      }
      if (searchQuery && !c.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [conversations, filter, searchQuery]);

  const grouped = useMemo(() => {
    const groups: Record<ConversationGroupKey, Conversation[]> = { today: [], yesterday: [], lastWeek: [], older: [] };
    for (const conversation of filtered) {
      groups[getConversationGroup(conversation.updatedAt)].push(conversation);
    }
    return groups;
  }, [filtered]);

  const selected = conversations.find((c) => c.id === activeConversationId) ?? null;

  const handleNewChat = () => {
    startNewConversation();
    navigate(ROUTES.chat);
  };

  const handleSelectConversation = (id: string) => {
    void selectConversation(id);
    setShowDetailOnMobile(true);
  };

  const handleContinueInChat = (id: string) => navigate(ROUTES.chatConversation(id));

  const handleRenameSubmit = (id: string) => {
    if (renameValue.trim()) void renameConversation(id, renameValue.trim());
    setRenamingId(null);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteConversation(deleteTarget.id);
      if (activeConversationId === deleteTarget.id) setShowDetailOnMobile(false);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiMessageSquare}
        title="History"
        subtitle="Every conversation you've had with the AI. Pick one to read it here, or continue it in Chat."
        actions={
          <Button leftIcon={<FiPlus />} onClick={handleNewChat}>
            New conversation
          </Button>
        }
      />

      {/* The tiles double as the filter — click one to show only those. */}
      <div className={styles.statRow} role="tablist" aria-label="Filter conversations">
        <StatTile label="All conversations" value={stats.total} icon={FiInbox} active={filter === 'all'} onClick={() => setFilter('all')} />
        <StatTile label="Pinned" value={stats.pinned} icon={FiBookmark} active={filter === 'pinned'} onClick={() => setFilter('pinned')} />
        <StatTile
          label="Favorites"
          value={stats.favorites}
          icon={FiStar}
          active={filter === 'favorites'}
          onClick={() => setFilter('favorites')}
        />
        <StatTile
          label="Archived"
          value={stats.archived}
          icon={FiArchive}
          active={filter === 'archived'}
          onClick={() => setFilter('archived')}
        />
      </div>

      <div className={styles.toolbar}>
        <Input
          placeholder="Search conversations by title…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          leftIcon={<FiSearch />}
          aria-label="Search chats"
        />
      </div>

      <div className={styles.layout} data-mobile-detail={showDetailOnMobile ? 'true' : 'false'}>
        <div className={styles.listColumn}>
          {filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon={searchQuery ? FiSearch : FiMessageSquare}
                title={searchQuery ? 'No conversations match your search' : 'No conversations here yet'}
                description={
                  searchQuery
                    ? 'Try a different word, or clear the search.'
                    : filter === 'all'
                      ? 'Start a new conversation and it will show up here.'
                      : 'Use the ••• menu on a conversation to add it here.'
                }
                action={
                  !searchQuery && filter === 'all' ? (
                    <Button leftIcon={<FiPlus />} onClick={handleNewChat}>
                      New conversation
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <LayoutGroup id="history-list">
              {GROUP_ORDER.map((groupKey) => {
                const items = grouped[groupKey];
                if (items.length === 0) return null;
                return (
                  <div key={groupKey}>
                    <div className={styles.groupLabel}>{CONVERSATION_GROUP_LABELS[groupKey]}</div>
                    <Card padded={false} className={styles.groupCard}>
                      <AnimatePresence initial={false}>
                        {items.map((conversation) => (
                          <motion.div
                            key={conversation.id}
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                            className={clsx(styles.item, activeConversationId === conversation.id && styles.itemActive)}
                            onClick={() => renamingId !== conversation.id && handleSelectConversation(conversation.id)}
                          >
                            {activeConversationId === conversation.id && (
                              <motion.span
                                layoutId="history-active"
                                className={styles.itemIndicator}
                                transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                              />
                            )}
                            <span className={styles.itemIconTile}>
                              <FiMessageSquare />
                            </span>
                            <div className={styles.itemMain}>
                              {renamingId === conversation.id ? (
                                <input
                                  autoFocus
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={() => handleRenameSubmit(conversation.id)}
                                  onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit(conversation.id)}
                                  className={styles.renameInput}
                                />
                              ) : (
                                <button
                                  type="button"
                                  className={styles.itemTitle}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSelectConversation(conversation.id);
                                  }}
                                >
                                  <span className={styles.itemTitleText}>{highlight(conversation.title, searchQuery)}</span>
                                  {conversation.pinned && <FiBookmark size={12} />}
                                  {conversation.favorite && <FiStar size={12} />}
                                </button>
                              )}
                              {conversation.preview && <div className={styles.itemPreview}>{conversation.preview}</div>}
                            </div>
                            <div className={styles.itemMeta}>{formatRelativeTime(conversation.updatedAt)}</div>
                            {/* Keeps menu clicks from also selecting the row. */}
                            <span className={styles.itemActionsWrap} onClick={(e) => e.stopPropagation()}>
                              <Dropdown
                                usePortal
                                align="right"
                                trigger={
                                  <button type="button" className={styles.itemActions} aria-label="Conversation actions">
                                    <FiMoreHorizontal />
                                  </button>
                                }
                                items={[
                                  {
                                    id: 'rename',
                                    label: 'Rename',
                                    icon: <FiEdit2 />,
                                    onSelect: () => {
                                      setRenamingId(conversation.id);
                                      setRenameValue(conversation.title);
                                    },
                                  },
                                  {
                                    id: 'pin',
                                    label: conversation.pinned ? 'Unpin' : 'Pin',
                                    icon: <FiBookmark />,
                                    onSelect: () => void toggleConversationFlag(conversation.id, 'pinned'),
                                  },
                                  {
                                    id: 'favorite',
                                    label: conversation.favorite ? 'Remove favorite' : 'Add to favorites',
                                    icon: <FiStar />,
                                    onSelect: () => void toggleConversationFlag(conversation.id, 'favorite'),
                                  },
                                  {
                                    id: 'archive',
                                    label: conversation.archived ? 'Unarchive' : 'Archive',
                                    icon: <FiArchive />,
                                    onSelect: () => void toggleConversationFlag(conversation.id, 'archived'),
                                  },
                                  {
                                    id: 'delete',
                                    label: 'Delete',
                                    icon: <FiTrash2 />,
                                    danger: true,
                                    separatorBefore: true,
                                    onSelect: () => setDeleteTarget(conversation),
                                  },
                                ]}
                              />
                            </span>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </Card>
                  </div>
                );
              })}
            </LayoutGroup>
          )}
        </div>

        <div className={styles.detailColumn}>
          {!selected ? (
            <div className={styles.detailEmpty}>
              <EmptyState
                icon={FiMessageSquare}
                title="Pick a conversation"
                description="Select one on the left to read the full thread here."
              />
            </div>
          ) : (
            <motion.div
              key={selected.id}
              className={styles.detailInner}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className={styles.detailHeader}>
                <button type="button" className={styles.detailBackButton} onClick={() => setShowDetailOnMobile(false)} aria-label="Back to list">
                  <FiArrowLeft />
                </button>
                <div className={styles.detailTitleRow}>
                  <div>
                    <div className={styles.detailTitle}>{selected.title}</div>
                    <div className={styles.detailMeta}>Last updated {formatRelativeTime(selected.updatedAt)}</div>
                  </div>
                </div>
                <div className={styles.detailActions}>
                  <Button size="sm" variant="secondary" rightIcon={<FiArrowRight />} onClick={() => handleContinueInChat(selected.id)}>
                    Continue in Chat
                  </Button>
                </div>
              </div>
              <div className={styles.detailMessages}>
                <MessageList messages={messages} isLoading={isLoadingMessages} />
              </div>
            </motion.div>
          )}
        </div>
      </div>

      <Modal open={!!deleteTarget} onClose={() => (deleting ? undefined : setDeleteTarget(null))} title="Delete conversation" maxWidth={420}>
        <div className={styles.confirmBody}>
          <p>
            <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--color-danger, #dc2626)' }} />
            Delete <strong>{deleteTarget?.title}</strong>? This permanently removes the conversation and cannot be undone.
          </p>
          <div className={styles.confirmActions}>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void handleConfirmDelete()} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
