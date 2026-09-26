import { FileDropUpload } from '@/components/common/FileDropUpload';
import { businessKnowledgeDocumentsService, type BusinessKnowledgeDocument } from '@/services/businessKnowledgeDocumentsService';

const ACCEPTED_EXTENSIONS = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.gif,.webp,.html,.htm,.txt,.md';

export interface BusinessKnowledgeDocumentUploadProps {
  onDocumentReady: (doc: BusinessKnowledgeDocument) => void;
}

export function BusinessKnowledgeDocumentUpload({ onDocumentReady }: BusinessKnowledgeDocumentUploadProps) {
  return (
    <FileDropUpload
      accept={ACCEPTED_EXTENSIONS}
      hint="PDF, Word, PowerPoint, Excel, CSV, images, HTML, text or Markdown"
      upload={(file) => businessKnowledgeDocumentsService.upload(file)}
      onUploaded={onDocumentReady}
      successMessage={(file, doc) =>
        doc.extractionStatus === 'completed' ? `${file.name} processed` : `${file.name} uploaded — extraction failed`
      }
    />
  );
}
