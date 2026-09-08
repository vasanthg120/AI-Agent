import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiCornerDownLeft, FiMessageCircle } from 'react-icons/fi';
import { Badge, Button, Input, SectionCard, Spinner } from '@/components/ui';
import { businessKnowledgeAdvisorService, type BusinessKnowledgeChatSource } from '@/services/businessKnowledgeAdvisorService';
import { extractErrorMessage } from '@/utils/errors';
import styles from '../business-knowledge.module.css';

const STARTER_QUESTIONS = [
  'Analyze my business',
  'What are my biggest business knowledge gaps?',
  'What should I improve first?',
  'What could be causing customer drop-off?',
  'What policies are missing?',
  'How can I improve my customer journey?',
];

interface Exchange {
  question: string;
  answer: string;
  sources: BusinessKnowledgeChatSource[];
}

// Dedicated, business-knowledge-only Q&A (POST /business-knowledge/chat) —
// distinct from the main Chat feature's general agent, which mixes in CRM/
// Outlook/documents. Stateless per exchange (no persisted conversation, no
// WebSocket) — a simple request/response, same reasoning as this being a
// focused advisor rather than a general-purpose assistant.
export function BusinessKnowledgeAdvisorSection() {
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [asking, setAsking] = useState(false);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    try {
      const result = await businessKnowledgeAdvisorService.ask(trimmed);
      setExchanges((prev) => [...prev, { question: trimmed, answer: result.answer, sources: result.sources }]);
      setQuestion('');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className={styles.tabContent}>
      <SectionCard title="AI Advisor" icon={FiMessageCircle}>
        <div className={styles.formGrid}>
          {exchanges.length === 0 && (
            <div className={styles.formGrid}>
              <p className={styles.emptyState} style={{ padding: 0 }}>
                Ask a question grounded in your own business profile and documents.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                {STARTER_QUESTIONS.map((q) => (
                  <Button key={q} size="sm" variant="secondary" onClick={() => ask(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {exchanges.map((exchange, index) => (
            <div key={index} className={styles.card} style={{ gap: 'var(--space-3)' }}>
              <strong style={{ fontSize: 'var(--text-sm)' }}>{exchange.question}</strong>
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
                {exchange.answer}
              </p>
              {exchange.sources.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  {exchange.sources.map((source) => (
                    <Badge key={source.index} variant="neutral">
                      [{source.index}] {source.filename ?? source.sourceType}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}

          {asking && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Spinner size={16} />
              <span className={styles.completenessRow}>Thinking…</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Input
              placeholder="Ask about your business…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') ask(question);
              }}
              style={{ flex: 1 }}
            />
            <Button leftIcon={<FiCornerDownLeft />} loading={asking} onClick={() => ask(question)}>
              Ask
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
