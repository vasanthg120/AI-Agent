import { Injectable } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { createBrandedDocument, drawTable, finalizePagedDocument, sectionHeading } from '../common/pdf/branded-pdf';
import { CustomerAddress, CustomerDirectoryService } from './customer-directory.service';
import { CustomerJobsService, JobDetail, JobItem } from './customer-jobs.service';

export type JobDocumentKind = 'job-sheet' | 'proof-sheet' | 'packing-slip' | 'decorator-spec-sheet' | 'shipping-label';

const TITLES: Record<JobDocumentKind, string> = {
  'job-sheet': 'Job Sheet',
  'proof-sheet': 'Proof Sheet',
  'packing-slip': 'Packing Slip',
  'decorator-spec-sheet': 'Decorator Spec Sheet',
  'shipping-label': 'Shipping Label',
};

// Hoops-parity Job actions — real PDF generation over the job's own already-
// computed detail (CustomerJobsService.detail), the same data JobPanel.tsx
// itself reads. No invoice/pricing logic lives here: Job Sheet and Packing
// Slip both deliberately leave price columns out (see buildItemsTable's own
// comment) — this reuses the branded-pdf.ts helper every other export in
// this codebase already renders through (finance, royalty, deals...).
@Injectable()
export class CustomerJobDocumentsService {
  constructor(
    private jobs: CustomerJobsService,
    private directory: CustomerDirectoryService,
  ) {}

  async generate(caller: JwtPayload, jobId: string, kind: JobDocumentKind): Promise<{ buffer: Buffer; filename: string }> {
    const job = await this.jobs.detail(caller, jobId);
    const address = job.customer.id ? await this.shippingAddress(caller.organizationId, job.customer.id) : undefined;

    const doc = createBrandedDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    switch (kind) {
      case 'job-sheet':
        await this.drawJobSheet(doc, job);
        break;
      case 'proof-sheet':
        await this.drawProofSheet(doc, job, caller);
        break;
      case 'packing-slip':
        this.drawPackingSlip(doc, job, address);
        break;
      case 'decorator-spec-sheet':
        this.drawDecoratorSpecSheet(doc, job);
        break;
      case 'shipping-label':
        this.drawShippingLabel(doc, job, address);
        break;
    }
    // finalizePagedDocument itself calls doc.end() — see its own comment
    // ("replaces the bare doc.end() at every controller call site").
    finalizePagedDocument(doc, { brandLine: `Job ${job.number}` });

    const buffer = await done;
    return { buffer, filename: `${TITLES[kind].replace(/\s+/g, '-')}-${job.number}.pdf` };
  }

  private async shippingAddress(organizationId: string, customerId: string): Promise<CustomerAddress | undefined> {
    try {
      const detail = await this.directory.detail(organizationId, customerId);
      return detail.addresses.find((a) => a.type === 'shipping') ?? detail.addresses[0];
    } catch {
      // The customer behind this job may since have been archived or merged — the document still
      // renders, just without an address, rather than failing the whole PDF over a lookup.
      return undefined;
    }
  }

  private drawCustomerBlock(doc: PDFKit.PDFDocument, job: JobDetail, address?: CustomerAddress) {
    sectionHeading(doc, 'Customer');
    doc.fontSize(10).fillColor('#070707');
    const lines = [
      job.contact.company ?? job.contact.name,
      job.contact.contact && job.contact.contact !== job.contact.company ? job.contact.contact : undefined,
      job.contact.email,
      job.contact.phone,
    ].filter(Boolean) as string[];
    for (const line of lines) doc.text(line);
    if (address) {
      doc.moveDown(0.3);
      doc.text([address.address, address.addressLine2].filter(Boolean).join(', '));
      doc.text([address.city, address.state].filter(Boolean).join(', '));
    } else {
      doc.fillColor('#666666').text('No shipping address on record.');
    }
    doc.moveDown();
  }

  private buildItemsTable(doc: PDFKit.PDFDocument, items: JobItem[], opts: { withPrice: boolean }) {
    drawTable<JobItem>(doc, {
      columns: [
        { label: 'Item', width: opts.withPrice ? 220 : 280, value: (i) => i.name },
        { label: 'Description', width: opts.withPrice ? 140 : 180, value: (i) => i.description ?? '' },
        { label: 'Qty', width: 50, align: 'right', value: (i) => String(i.quantity) },
        ...(opts.withPrice
          ? [
              { label: 'Unit', width: 60, align: 'right' as const, value: (i: JobItem) => i.unitPrice.toFixed(2) },
              { label: 'Total', width: 70, align: 'right' as const, value: (i: JobItem) => i.total.toFixed(2) },
            ]
          : []),
        { label: 'Status', width: 90, value: (i) => i.label },
      ],
      rows: items,
    });
  }

  private async drawJobSheet(doc: PDFKit.PDFDocument, job: JobDetail) {
    drawHeaderFor(doc, job, 'Job Sheet');
    this.drawCustomerBlock(doc, job);
    sectionHeading(doc, 'Job');
    doc
      .fontSize(10)
      .fillColor('#070707')
      .text(`Due date: ${job.dueDate ? new Date(job.dueDate).toLocaleDateString() : 'Not set'}`)
      .text(`Owner: ${job.owner ?? 'Unassigned'}`)
      .text(`From quotation: ${job.quotationNumber ?? '—'}`);
    doc.moveDown();
    sectionHeading(doc, 'Items');
    this.buildItemsTable(doc, job.items, { withPrice: true });
  }

  private async drawProofSheet(doc: PDFKit.PDFDocument, job: JobDetail, caller: JwtPayload) {
    drawHeaderFor(doc, job, 'Proof Sheet');
    this.drawCustomerBlock(doc, job);
    const attached = await this.jobs.workspaceOf(caller, job.id).catch(() => null);
    const proofs = (attached?.files ?? []).filter((f) => f.kind === 'proof');
    sectionHeading(doc, 'Artwork proofs');
    if (proofs.length === 0) {
      doc.fontSize(10).fillColor('#666666').text('No proofs have been uploaded for this job yet.');
    } else {
      drawTable(doc, {
        columns: [
          { label: 'File', width: 260, value: (f: (typeof proofs)[number]) => f.name },
          { label: 'Status', width: 120, value: (f: (typeof proofs)[number]) => f.proofStatus ?? 'Pending' },
          { label: 'Uploaded', width: 150, value: (f: (typeof proofs)[number]) => new Date(f.at).toLocaleDateString() },
        ],
        rows: proofs,
      });
    }
  }

  private drawPackingSlip(doc: PDFKit.PDFDocument, job: JobDetail, address?: CustomerAddress) {
    drawHeaderFor(doc, job, 'Packing Slip');
    this.drawCustomerBlock(doc, job, address);
    sectionHeading(doc, 'Contents');
    // No prices on a packing slip — what's going in the box, not what it costs.
    this.buildItemsTable(doc, job.items, { withPrice: false });
  }

  private drawDecoratorSpecSheet(doc: PDFKit.PDFDocument, job: JobDetail) {
    drawHeaderFor(doc, job, 'Decorator Spec Sheet');
    sectionHeading(doc, 'Items to decorate');
    doc
      .fontSize(9)
      .fillColor('#666666')
      .text('Vendor, colour and size are tracked per catalog item, not per job line, in this organization today — only what the job itself records is shown below.');
    doc.moveDown(0.5);
    this.buildItemsTable(doc, job.items, { withPrice: false });
  }

  private drawShippingLabel(doc: PDFKit.PDFDocument, job: JobDetail, address?: CustomerAddress) {
    doc.fontSize(18).fillColor('#070707').text(job.contact.company ?? job.contact.name, { align: 'left' });
    doc.fontSize(12).fillColor('#070707');
    if (job.contact.contact && job.contact.contact !== job.contact.company) doc.text(job.contact.contact);
    if (address) {
      doc.moveDown(0.3);
      doc.text([address.address, address.addressLine2].filter(Boolean).join(', '));
      doc.text([address.city, address.state].filter(Boolean).join(', '));
    } else {
      doc.fillColor('#666666').text('No shipping address on record — add one from the customer’s Edit Customer form.');
    }
    doc.moveDown(1);
    doc.fontSize(10).fillColor('#666666').text(`Job ${job.number}${job.quotationNumber ? ` · Quote ${job.quotationNumber}` : ''}`);
  }
}

function drawHeaderFor(doc: PDFKit.PDFDocument, job: JobDetail, title: string) {
  doc.fontSize(18).fillColor('#070707').text(title, { continued: false });
  doc.fontSize(11).fillColor('#666666').text(`Job ${job.number} — ${job.title}`);
  doc.moveDown();
}
