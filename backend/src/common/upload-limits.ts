import * as os from 'os';
import { diskStorage } from 'multer';

// Shared across every FileInterceptor('file', ...) call site (finance
// documents, business-knowledge documents, generic documents, agent-role
// generation) — previously none of them set any limit at all, so Multer
// buffered an arbitrarily large upload fully in memory before the handler
// ever ran, a straightforward single-request OOM/DoS vector. 25MB comfortably
// covers a scanned multi-page PDF/invoice, the actual documents this app's
// upload routes are built for.
export const UPLOAD_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

export const UPLOAD_FILE_INTERCEPTOR_OPTIONS = {
  limits: { fileSize: UPLOAD_FILE_SIZE_LIMIT_BYTES },
};

// call-copilot's "upload a recording" flow ONLY — deliberately a SEPARATE
// constant from UPLOAD_FILE_SIZE_LIMIT_BYTES above, never applied to any
// other upload site. A full call recording (Sarvam's Batch STT API supports
// files up to 2 hours) is an order of magnitude larger than the documents
// every other upload route here is sized for; 300MB comfortably covers a
// 2-hour recording even at a generous bitrate.
export const CALL_RECORDING_UPLOAD_SIZE_LIMIT_BYTES = 300 * 1024 * 1024;

// UNLIKE every other FileInterceptor site in this repo (which use Multer's
// default in-memory buffering — fine at the 25MB scale above), this one uses
// disk storage: buffering up to 300MB per concurrent upload fully in memory
// is a real OOM risk at this size, over 10x worse than the shared limit's
// own worst case. The service reading `file.path` here is responsible for
// deleting the temp file once it's done with it (see
// call-copilot-upload.service.ts's startUploadSession) — Multer's disk
// storage does NOT clean up after itself.
export const CALL_RECORDING_UPLOAD_INTERCEPTOR_OPTIONS = {
  storage: diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: CALL_RECORDING_UPLOAD_SIZE_LIMIT_BYTES },
};
