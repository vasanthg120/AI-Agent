import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiAlertTriangle } from 'react-icons/fi';
import { EmptyState, Modal } from '@/components/ui';
import { callCopilotService, hasCoachingReport, type CallSessionDetail } from '@/services/callCopilotService';
import { CallSummaryModal } from './CallSummaryModal';
import { FailedCallDialog } from './FailedCallDialog';

// Opens one call by its id, wherever it is listed (Agent Activity, the deal
// panel, the team's Call Library): its summary, AI Coach report, transcript
// and recording. A teammate's call opens read-only (the server says so).
export function CallSessionViewer({ sessionId, onClose, onChanged }: { sessionId: string | null; onClose: () => void; onChanged?: () => void }) {
  const [session, setSession] = useState<CallSessionDetail | null>(null);

  useEffect(() => {
    setSession(null);
    if (!sessionId) return;
    let stale = false;
    callCopilotService
      .getSession(sessionId)
      .then((s) => {
        if (!stale) setSession(s);
      })
      .catch(() => {
        if (stale) return;
        toast.error("Couldn't open that call. Please try again.");
        onClose();
      });
    return () => {
      stale = true;
    };
    // onClose is a fresh function on every render of the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  if (!sessionId || !session) return null;

  if (session.status === 'error') {
    if (!session.readOnly) {
      return (
        <FailedCallDialog
          session={session}
          onClose={onClose}
          onRetried={() => {
            onClose();
            onChanged?.();
          }}
        />
      );
    }
    return (
      <Modal open onClose={onClose} title={session.ownerName ? `Call by ${session.ownerName}` : 'Call'} description={session.businessName} maxWidth={520}>
        <EmptyState
          compact
          icon={FiAlertTriangle}
          title="This call couldn’t be processed"
          description={session.errorMessage ?? 'Something went wrong while processing it.'}
        />
      </Modal>
    );
  }

  return (
    <CallSummaryModal
      open
      onClose={onClose}
      source={session.source}
      originalFilename={session.originalFilename}
      summaryResult={session}
      segments={session.transcript}
      sessionId={session._id}
      createdAt={session.source === 'live' ? session.createdAt : undefined}
      sentiment={session.sentiment}
      coaching={hasCoachingReport(session) ? session : undefined}
      onCoachingGenerated={(report) => setSession((prev) => (prev ? { ...prev, ...report } : prev))}
      readOnly={session.readOnly}
      ownerName={session.readOnly ? session.ownerName : undefined}
      businessName={session.readOnly ? session.businessName : undefined}
    />
  );
}
