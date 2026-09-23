// Shared, dependency-free pdfkit helpers (no NestJS DI — plain functions over
// a caller-supplied PDFKit.PDFDocument) so every export service renders a
// consistent, branded document instead of each one hand-rolling its own
// bullet-list `.text()` calls. See billing-invoice-pdf.service.ts,
// tasks-export.service.ts, finance-export.service.ts, royalty-report-export.service.ts,
// deals-export.service.ts, and email-analytics-export.service.ts for the
// call sites this replaces.
//
// PDFKit quirks this file works around (verified against the installed
// pdfkit ^0.19.1, not assumed):
// - pdfkit's native `doc.table()` (added in 0.19) does NOT repeat header
//   rows across a page break — drawTable() below hand-rolls that.
// - `doc.image()` must be called with the *string* data URI (not a Buffer)
//   — pdfkit's image cache is keyed by string src, so passing the same
//   string on every call dedupes the embed instead of re-encoding a fresh
//   copy of the logo into the file each time.
// - Any text drawn at an absolute Y inside the bottom margin band (i.e. a
//   footer) must pass `{ lineBreak: false }`, otherwise pdfkit's line
//   wrapper sees `y > maxY` and silently inserts an extra blank page before
//   drawing, corrupting bufferedPageRange()'s page count.
// - pdfkit's color parser accepts #hex/named/[r,g,b], not CSS `rgba(...)` —
//   so the frontend's `--color-border: rgba(7,7,7,0.1)` can't be reused
//   verbatim; BRAND.border below uses the real `--brand-surface-light` hex
//   token instead.
import PDFDocument from 'pdfkit';

export const BRAND = {
  accent: '#d96f1f',
  ink: '#070707',
  muted: '#666666',
  border: '#e1ded4',
};

// Copied verbatim from frontend/src/features/billing/haiveLogoDataUri.ts
// (itself generated from frontend/public/haive-logo.png) — the backend has
// no runtime access to frontend files, so this is the server-side copy of
// the exact same asset, not a new logo. Keep the two in sync if it changes.
export const HAIVE_LOGO_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAABAKADAAQAAAABAAABAAAAAABn6hpJAAAh/klEQVR4Ae2dCZwUxfXHq7rn2p292F2WY5cs4HKrgCByqJFIgmc0GogaDxI1hwdqNCoeuGKMJ9EYr6iYv0eMwah//0RjvAAlKAKKIjeCuLBce7PHTE931/9VLyYr2cXpubZn+lcf+Tg7U8er76t6XV3XYwwBBEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAg4QR4wnPMoAzFwkpP2L/rBN684XBecPggs6WqgKveSAZVMeOqIoyIVwn2axANn24SOUM+9Yd/9DqfPFnPuIomqEIwAJ2AFB9c0SvUtOEKFq4+Vxgt/URoL2P6PsY8QYotOkmBr5xDgJq03kK6ymXc35Nxb842llX6TCAw/A980r17nCOnMySBAThAD/rHc86JbH/+XrO1ug/jnHElwJjio1jo+Aegcvif1LSFxoTeZulOySqr9pafO9MzctaLDhc8peLBAHTAHX7jxNlGw4e3ChGhJ0cB/SLxoON3QJSGH9ubuIjUkypNpvY949rAsU/fk4YVSYrISlJyTcNMtSW/uEqvXXQrPfIZ9xXurwE6fxqq8gCRpQ6FpVOuBpix44W7tQ+vuuSASK79EyMAUr32yV3jI5vmvs/pCcFUvOdnbG8g4y4ijVQ9hXkPu22sb9glKzO2rlFWDCMAAmVsfepxprfSxFEO/YWnfpRtJ/2ikYHn3nxSeIjpGx9+Mv0qkHiJXW8A9GWXn2yGth1qvfPLEQBCZhOQRsDfg4m2rYeHPrzqhMyu7DfXDgagaf1M66nP1W+mhRgZQoB0LWhrQMu2n2dIhWKuhqsNgNj1dNBs3jgR7/0xt580TUiveWouMxpWfUdUL8hO00okRGxXGwB9157RjKs5nCaHENxF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';

export const HEADER_LOGO_SIZE = 36;
const FOOTER_RESERVE = 40;
const ROW_HEIGHT = 20;
const HEADER_ROW_HEIGHT = 22;
const CELL_PADDING_X = 6;

export function createBrandedDocument(): PDFKit.PDFDocument {
  return new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
}

function contentBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > contentBottom(doc)) doc.addPage();
}

export function drawHeader(doc: PDFKit.PDFDocument, opts: { title: string; subtitle?: string; accentHex?: string; showLogo?: boolean }): void {
  const accent = opts.accentHex ?? BRAND.accent;
  const showLogo = opts.showLogo ?? true;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  let y = doc.page.margins.top;
  const wordmarkX = showLogo ? left + HEADER_LOGO_SIZE + 10 : left;

  if (showLogo) {
    try {
      doc.image(HAIVE_LOGO_DATA_URI, left, y, { width: HEADER_LOGO_SIZE, height: HEADER_LOGO_SIZE });
    } catch {
      // Best-effort — a bad logo asset must never block the rest of the document.
    }
  }
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(BRAND.ink)
    .text('Haive', wordmarkX, y + (HEADER_LOGO_SIZE - 14) / 2, { lineBreak: false });

  y += HEADER_LOGO_SIZE + 14;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND.ink).text(opts.title, left, y, { width: right - left });
  y = doc.y + 2;
  if (opts.subtitle) {
    doc.font('Helvetica').fontSize(10).fillColor(BRAND.muted).text(opts.subtitle, left, y, { width: right - left });
    y = doc.y + 8;
  } else {
    y += 8;
  }

  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(accent).stroke();

  doc.x = left;
  doc.y = y + 16;
  doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink);
}

export function sectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  ensureSpace(doc, 28);
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.ink).text(text, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink);
  doc.moveDown(0.3);
}

export interface PdfColumn<T> {
  label: string;
  width: number | 'auto';
  align?: 'left' | 'right' | 'center';
  value: (row: T) => string;
}

// Truncates to a single line with an ellipsis instead of letting pdfkit wrap
// it. Cell text used to be drawn with a `width` option for alignment, which
// routes through pdfkit's line wrapper — for anything longer than its column
// (a real vendor/deal/task name routinely is) that wraps onto a second line,
// which then overlaps the fixed-height row below it instead of clipping.
// Truncating up front keeps every row exactly ROW_HEIGHT tall.
function fitText(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = '…';
  let clipped = text;
  while (clipped.length > 0 && doc.widthOfString(clipped + ellipsis) > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return clipped.length > 0 ? clipped + ellipsis : ellipsis;
}

// Draws single-line cell text without ever passing `width` to `.text()` —
// same reasoning as finalizePagedDocument's footer: a `width` option always
// goes through the line wrapper (wrapping/page-break checks included) even
// with `lineBreak:false`. Pre-fitting the string and positioning it manually
// avoids that entirely, so alignment is exact and rows never overlap.
function drawCellText(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, align: 'left' | 'right' | 'center'): void {
  const fitted = fitText(doc, text, width);
  const w = doc.widthOfString(fitted);
  const drawX = align === 'right' ? x + width - w : align === 'center' ? x + (width - w) / 2 : x;
  doc.text(fitted, drawX, y, { lineBreak: false });
}

// Hand-rolled rather than pdfkit's own native doc.table() (added in 0.19) —
// that one never repeats the header row across a page break, which is a
// hard requirement here (long task/deal/invoice lists routinely span pages).
export function drawTable<T>(doc: PDFKit.PDFDocument, opts: { columns: PdfColumn<T>[]; rows: T[]; accentHex?: string }): void {
  const { columns, rows, accentHex } = opts;
  const accent = accentHex ?? BRAND.accent;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;

  const fixedWidth = columns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : 0), 0);
  const autoCols = columns.filter((c) => c.width === 'auto').length;
  const autoWidth = autoCols > 0 ? Math.max(50, (tableWidth - fixedWidth) / autoCols) : 0;
  const widths = columns.map((c) => (typeof c.width === 'number' ? c.width : autoWidth));

  const drawHeaderRow = (): void => {
    ensureSpace(doc, HEADER_ROW_HEIGHT + ROW_HEIGHT);
    const y = doc.y;
    doc.rect(left, y, tableWidth, HEADER_ROW_HEIGHT).fill(accent);
    let x = left;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    columns.forEach((col, i) => {
      drawCellText(doc, col.label, x + CELL_PADDING_X, y + 6, widths[i] - CELL_PADDING_X * 2, col.align ?? 'left');
      x += widths[i];
    });
    doc.y = y + HEADER_ROW_HEIGHT;
    doc.font('Helvetica').fillColor(BRAND.ink);
  };

  drawHeaderRow();

  rows.forEach((row, rowIndex) => {
    if (doc.y + ROW_HEIGHT > contentBottom(doc)) drawHeaderRow();
    const y = doc.y;
    if (rowIndex % 2 === 1) {
      doc.rect(left, y, tableWidth, ROW_HEIGHT).fill(BRAND.border);
    }
    let x = left;
    doc.fontSize(9).fillColor(BRAND.ink);
    columns.forEach((col, i) => {
      drawCellText(doc, col.value(row), x + CELL_PADDING_X, y + 5, widths[i] - CELL_PADDING_X * 2, col.align ?? 'left');
      x += widths[i];
    });
    doc.moveTo(left, y + ROW_HEIGHT).lineTo(right, y + ROW_HEIGHT).lineWidth(0.5).strokeColor(BRAND.border).stroke();
    doc.y = y + ROW_HEIGHT;
  });

  doc.x = left;
  doc.moveDown(0.6);
  doc.fillColor(BRAND.ink);
}

// Draws a branded footer (brand line + "Page X of Y") on every buffered
// page, then ends the document — replaces the bare `doc.end()` at every
// controller call site. Must run after all content is drawn (relies on
// `createBrandedDocument()`'s `bufferPages: true` so bufferedPageRange()
// reports every page, not just whatever hasn't flushed yet).
export function finalizePagedDocument(doc: PDFKit.PDFDocument, opts: { brandLine?: string } = {}): void {
  const brandLine = opts.brandLine ?? `Haive · Generated ${new Date().toLocaleDateString()}`;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom + 14;

    doc.moveTo(left, y - 6).lineTo(right, y - 6).lineWidth(0.5).strokeColor(BRAND.border).stroke();
    doc.fontSize(8).fillColor(BRAND.muted);
    // Deliberately NOT passing `width` here (even with `lineBreak: false`):
    // pdfkit's text() only skips the *default*-width computation when
    // lineBreak is false — passing an explicit width still routes through
    // LineWrapper.wrap(), which re-checks `y > maxY` regardless and inserts
    // a spurious extra page since a footer is intentionally drawn inside
    // the bottom margin band. Omitting `width` takes the no-wrapper code
    // path entirely, so alignment is done manually via widthOfString().
    doc.text(brandLine, left, y, { lineBreak: false });
    const pageLabel = `Page ${i - range.start + 1} of ${range.count}`;
    doc.text(pageLabel, right - doc.widthOfString(pageLabel), y, { lineBreak: false });
  }
  doc.end();
}
