import styles from './CustomerContextCard.module.css';

// contextBlob is the pre-formatted text business_search_tool.run() already
// produces (numbered "[n] (source_type) ..." lines merging CRM + documents +
// business knowledge + Mem0 memory) — shown as-is rather than re-parsed, the
// same way search_business_context's output is consumed directly by Claude.
export function CustomerContextCard({ contextBlob }: { contextBlob: string }) {
  if (!contextBlob) {
    return <p className={styles.empty}>No linked CRM/RAG context for this call — recommendations will use general business knowledge only.</p>;
  }
  return <div className={styles.blob}>{contextBlob}</div>;
}
