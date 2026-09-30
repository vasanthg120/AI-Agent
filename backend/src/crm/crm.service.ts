import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { currentDataSourceScope } from '../data-sources/data-source-context';
import { Account, AccountDocument } from './schemas/account.schema';
import { Contact, ContactDocument } from './schemas/contact.schema';
import { Deal, DealDocument } from './schemas/deal.schema';
import { Note, NoteDocument } from './schemas/note.schema';
import { Quote, QuoteDocument } from './schemas/quote.schema';
import { Tag, TagDocument } from './schemas/tag.schema';

/**
 * Native CRM backing store — implements the same request/response shapes
 * python-agent's crm_*_tool.py files already send/expect against an external
 * CRM (see prospectconnect.py), so those tool files need no changes: an org
 * with no external CRM connected gets routed here instead (see
 * prospectconnect.py's native fallback), and everything downstream (the
 * sales_consultant persona, the RAG business sync job) keeps working
 * unmodified.
 */
@Injectable()
export class CrmService {
  constructor(
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Account.name) private accountModel: Model<AccountDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectModel(Note.name) private noteModel: Model<NoteDocument>,
    @InjectModel(Tag.name) private tagModel: Model<TagDocument>,
  ) {}

  // ---- contacts ----

  async upsertContact(organizationId: string, data: Record<string, unknown>) {
    const contactId = data.contact_id as string | undefined;
    const email = data.email as string | undefined;
    const phone = data.phone as string | undefined;

    const update: Record<string, unknown> = {};
    if (data.first_name !== undefined) update.firstName = data.first_name;
    if (data.last_name !== undefined) update.lastName = data.last_name;
    if (data.name !== undefined) update.name = data.name;
    if (email !== undefined) update.email = email;
    if (phone !== undefined) update.phone = phone;
    if (data.tags !== undefined) update.tags = data.tags;

    // This is the HaiVE workspace's own contact store (the AI tools' native
    // CRM). It must never match — and overwrite — a contact synced from a
    // connected CRM that happens to share an email or phone number.
    const nativeSourceId = currentDataSourceScope()?.nativeSourceId;
    const ownSource = nativeSourceId ? { dataSourceId: nativeSourceId } : {};
    const filter = contactId
      ? { _id: contactId, organizationId, ...ownSource }
      : { organizationId, ...ownSource, $or: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] };

    const saved = await this.contactModel.findOneAndUpdate(filter, { $set: { organizationId, ...ownSource, ...update } }, { upsert: true, new: true }).exec();
    return { contact: saved };
  }

  async searchContactsByIds(organizationId: string, ids: string[]) {
    const contacts = await this.contactModel.find({ organizationId, _id: { $in: ids } }).exec();
    return { contacts };
  }

  /** Returns {count, data} — RAG business sync consumes this shape directly. */
  async listContacts(organizationId: string, opts: { searchAfter?: number; limit?: number; searchText?: string }) {
    const filter: Record<string, unknown> = { organizationId };
    if (opts.searchText) {
      filter.$or = [{ name: { $regex: opts.searchText, $options: 'i' } }, { email: { $regex: opts.searchText, $options: 'i' } }];
    }
    const limit = opts.limit ?? 50;
    const skip = opts.searchAfter ?? 0;
    const [data, count] = await Promise.all([
      this.contactModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      this.contactModel.countDocuments(filter).exec(),
    ]);
    return { count, data };
  }

  // ---- deals ----

  /** Returns {total, deal} — matches crm_deal_tool.py's docstring contract. */
  async listDeals(organizationId: string, opts: { page?: number; offset?: number; pageLimit?: number; search?: string; pipelineId?: string }) {
    const filter: Record<string, unknown> = { organizationId };
    if (opts.pipelineId) filter.pipelineId = opts.pipelineId;
    if (opts.search) filter.name = { $regex: opts.search, $options: 'i' };

    const pageLimit = opts.pageLimit ?? 25;
    const skip = opts.offset ?? (opts.page ? (opts.page - 1) * pageLimit : 0);
    const [deal, total] = await Promise.all([
      this.dealModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageLimit).exec(),
      this.dealModel.countDocuments(filter).exec(),
    ]);
    return { total, deal };
  }

  // ---- notes ----

  /** Returns a bare array — crm_note_tool.py expects a raw list, not a wrapper. */
  async getNotes(organizationId: string, contactId: string, dealId?: string, accountId?: string) {
    const filter: Record<string, unknown> = { organizationId, contactId };
    if (dealId) filter.dealId = dealId;
    if (accountId) filter.accountId = accountId;
    return this.noteModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  // ---- tags ----

  async listTags(organizationId: string, opts: { name?: string; moduleName?: string; limit?: number; offset?: number }) {
    const filter: Record<string, unknown> = { organizationId, moduleName: opts.moduleName ?? 'contact' };
    if (opts.name) filter.name = { $regex: opts.name, $options: 'i' };
    const tags = await this.tagModel
      .find(filter)
      .skip(opts.offset ?? 0)
      .limit(opts.limit ?? 25)
      .exec();
    return { tags };
  }

  // ---- accounts ----

  /** Returns {data} — matches crm_account_tool.py's _fetch_raw_accounts contract. */
  async listAccounts(organizationId: string, opts: { name?: string; limit?: number; offset?: number }) {
    const filter: Record<string, unknown> = { organizationId };
    if (opts.name) filter.name = { $regex: opts.name, $options: 'i' };
    const data = await this.accountModel
      .find(filter)
      .skip(opts.offset ?? 0)
      .limit(opts.limit ?? 25)
      .exec();
    return { data };
  }

  // ---- products ---- (no native product catalog yet — empty but well-shaped)

  listProducts(_organizationId: string) {
    return { count: 0, product: [] as unknown[] };
  }

  // ---- quotes ----

  /** Returns {count, quotes} — matches crm_quote_tool.py's _fetch_raw_quotes contract. */
  async listQuotes(organizationId: string, opts: { search?: string; dealId?: string; limit?: number; startAfter?: number }) {
    const filter: Record<string, unknown> = { organizationId };
    if (opts.dealId) filter.dealId = opts.dealId;
    if (opts.search) filter.quoteName = { $regex: opts.search, $options: 'i' };
    const [quotes, count] = await Promise.all([
      this.quoteModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(opts.startAfter ?? 0)
        .limit(opts.limit ?? 25)
        .exec(),
      this.quoteModel.countDocuments(filter).exec(),
    ]);
    return { count, quotes };
  }
}
