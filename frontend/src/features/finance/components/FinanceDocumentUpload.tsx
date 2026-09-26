import { FileDropUpload } from '@/components/common/FileDropUpload';
import { financeDocumentsService, type FinanceDocument } from '@/services/financeDocumentsService';

const ACCEPTED_EXTENSIONS = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.csv,.docx';

export interface FinanceDocumentUploadProps {
  onDocumentReady: (doc: FinanceDocument) => void;
}

// Real vendor-payment uploads arrive in batches — FileDropUpload processes
// them sequentially, not in parallel, so they never pile up concurrent LLM
// extraction calls.
export function FinanceDocumentUpload({ onDocumentReady }: FinanceDocumentUploadProps) {
  return (
    <FileDropUpload
      accept={ACCEPTED_EXTENSIONS}
      hint="Invoices and receipts — PDF, images, Excel, CSV or Word. The AI reads the vendor, amount and due date for you."
      upload={(file) => financeDocumentsService.upload(file)}
      onUploaded={onDocumentReady}
      successMessage={(file, doc) =>
        doc.extractionStatus === 'completed' ? `${file.name} processed` : `${file.name} uploaded — extraction failed`
      }
    />
  );
}
