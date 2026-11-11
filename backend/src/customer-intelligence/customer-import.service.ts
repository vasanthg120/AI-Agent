import { BadRequestException, Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { Readable } from 'stream';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UsersService } from '../users/users.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { AddressType, CreateCustomerDto, CustomerType } from './dto/customer-profile.dto';

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportCustomerDraft {
  row: number;
  dto: CreateCustomerDto;
  // What the row would read as, for the preview table — not sent anywhere.
  summary: string;
}

export interface ImportPreviewResult {
  customers: ImportCustomerDraft[];
  errors: ImportRowError[];
}

export interface ImportCommitResult {
  created: number;
  skippedDuplicates: { row: number; name: string; existingId: string }[];
  errors: ImportRowError[];
}

// CSV_TEMPLATE_HEADERS and the parser below are the one schema the template
// download and the importer both read against — they can never drift apart
// (same convention as the Catalog Decoration importer's own comment). One
// row per customer; Contact */Address * columns are each a single inline
// contact/address — a customer needing more than one of either still gets
// them added afterwards from the Edit Customer form's own Contacts/Address
// sections, which call the same real addContact/addAddress endpoints.
export const CSV_TEMPLATE_HEADERS = [
  'Type',
  'Company Name',
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Website',
  'Industry Type',
  'Minimum Markup',
  'Sales Discount',
  'Customer Rep Email',
  'Contact Name',
  'Contact Email',
  'Contact Phone',
  'Address Type',
  'Address',
  'Address Line 2',
  'City',
  'State',
];
const EXAMPLE_ROWS = [
  [
    'Business',
    'Acme Promotional Products',
    '',
    '',
    'orders@acme.example.com',
    '0400 000 111',
    'acme.example.com',
    'Retail',
    '15',
    '5',
    'rep@yourcompany.example.com',
    'Jordan Lee',
    'jordan@acme.example.com',
    '0400 000 222',
    'billing',
    '1 Example St',
    '',
    'Sydney',
    'NSW',
  ],
  ['Individual', '', 'Sam', 'Taylor', 'sam.taylor@example.com', '0400 000 333', '', '', '', '', '', '', '', '', '', '', '', '', ''],
];

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildCustomerImportTemplateCsv(): string {
  return [CSV_TEMPLATE_HEADERS, ...EXAMPLE_ROWS].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

@Injectable()
export class CustomerImportService {
  constructor(
    private directory: CustomerDirectoryService,
    private users: UsersService,
  ) {}

  // Shared by preview and commit — parses the CSV against
  // CSV_TEMPLATE_HEADERS, validates each row (required fields by type,
  // numeric ranges, a rep email that really belongs to this organization),
  // and resolves it into the exact CreateCustomerDto createCustomer itself
  // takes. Never writes to the database.
  async parseImportFile(organizationId: string, buffer: Buffer): Promise<ImportPreviewResult> {
    const workbook = new Workbook();
    let worksheet;
    try {
      worksheet = await workbook.csv.read(Readable.from(buffer));
    } catch {
      throw new BadRequestException('Could not read this file as CSV.');
    }

    const repsByEmail = new Map((await this.users.findAll(organizationId)).map((u) => [(u.email ?? '').toLowerCase(), u]));

    const errors: ImportRowError[] = [];
    const customers: ImportCustomerDraft[] = [];
    let headerSeen = false;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const v = row.values as unknown[];
      const cell = (i: number) => String(v[i] ?? '').trim();

      const typeRaw = cell(1);
      if (!headerSeen) {
        headerSeen = true;
        if (typeRaw.toLowerCase() === CSV_TEMPLATE_HEADERS[0].toLowerCase()) return;
      }

      const companyName = cell(2);
      const firstName = cell(3);
      const lastName = cell(4);
      const email = cell(5);
      const phone = cell(6);
      const website = cell(7);
      const industryType = cell(8);
      const markupRaw = cell(9);
      const discountRaw = cell(10);
      const repEmail = cell(11).toLowerCase();
      const contactName = cell(12);
      const contactEmail = cell(13);
      const contactPhone = cell(14);
      const addressType = cell(15).toLowerCase();
      const address = cell(16);
      const addressLine2 = cell(17);
      const city = cell(18);
      const state = cell(19);

      const typeLower = typeRaw.toLowerCase();
      // An explicit Type column always wins, even when the row is otherwise
      // incomplete (a "Business" row with a blank Company Name is a
      // validation error below, not a silent reclassification to Individual).
      const type: CustomerType = typeLower === 'business' ? 'business' : typeLower === 'individual' ? 'individual' : companyName ? 'business' : 'individual';
      if (type === 'business' && !companyName) {
        errors.push({ row: rowNumber, message: 'Company Name is required for a Business row.' });
        return;
      }
      if (type === 'individual' && !firstName) {
        errors.push({ row: rowNumber, message: 'First Name is required for an Individual row.' });
        return;
      }
      if (type === 'individual' && !email) {
        errors.push({ row: rowNumber, message: 'Email is required for an Individual row.' });
        return;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({ row: rowNumber, message: `"${email}" doesn't look like a valid email.` });
        return;
      }
      const markup = markupRaw === '' ? undefined : Number(markupRaw);
      if (markup !== undefined && (!Number.isFinite(markup) || markup < 0 || markup > 100)) {
        errors.push({ row: rowNumber, message: 'Minimum Markup must be a number between 0 and 100.' });
        return;
      }
      const discount = discountRaw === '' ? undefined : Number(discountRaw);
      if (discount !== undefined && (!Number.isFinite(discount) || discount < 0 || discount > 100)) {
        errors.push({ row: rowNumber, message: 'Sales Discount must be a number between 0 and 100.' });
        return;
      }
      let repUserId: string | undefined;
      if (repEmail) {
        const rep = repsByEmail.get(repEmail);
        if (!rep) {
          errors.push({ row: rowNumber, message: `No active user with email "${repEmail}" in this organization.` });
          return;
        }
        repUserId = rep._id.toString();
      }

      const name = type === 'business' ? companyName : [firstName, lastName].filter(Boolean).join(' ');
      const dto: CreateCustomerDto = {
        name,
        company: type === 'business' ? companyName : undefined,
        email: email || undefined,
        phone: phone || undefined,
        repUserId,
        customerType: type,
        website: type === 'business' ? website || undefined : undefined,
        industryType: type === 'business' ? industryType || undefined : undefined,
        minimumMarkupPct: type === 'business' ? markup : undefined,
        salesDiscountPct: type === 'business' ? discount : undefined,
        contacts: contactName ? [{ name: contactName, email: contactEmail || undefined, phone: contactPhone || undefined }] : undefined,
        addresses: address
          ? [
              {
                type: (['billing', 'shipping', 'other'].includes(addressType) ? addressType : 'other') as AddressType,
                address,
                addressLine2: addressLine2 || undefined,
                city: city || undefined,
                state: state || undefined,
              },
            ]
          : undefined,
      };
      customers.push({ row: rowNumber, dto, summary: [name, email, phone].filter(Boolean).join(' · ') });
    });

    return { customers, errors };
  }

  // Commits a parsed import: each row goes through createCustomer exactly
  // as the Add Customer form itself would submit it — same duplicate check,
  // same crm_contacts insert, same profile fields — so an imported customer
  // is indistinguishable from one added by hand or found by a CRM sync.
  // Per the spec's own "never overwrite without an explicit update option":
  // a row that matches an existing customer is skipped and reported, never
  // silently merged into it.
  async importRows(user: JwtPayload, drafts: ImportCustomerDraft[]): Promise<ImportCommitResult> {
    let created = 0;
    const skippedDuplicates: ImportCommitResult['skippedDuplicates'] = [];
    const errors: ImportRowError[] = [];
    for (const draft of drafts) {
      try {
        const result = await this.directory.createCustomer(user, draft.dto);
        if (result.duplicate) skippedDuplicates.push({ row: draft.row, name: draft.dto.name, existingId: result.duplicate.id });
        else created++;
      } catch (err) {
        errors.push({ row: draft.row, message: err instanceof Error ? err.message : 'Could not create this customer.' });
      }
    }
    return { created, skippedDuplicates, errors };
  }
}
