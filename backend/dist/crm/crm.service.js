"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrmService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const data_source_context_1 = require("../data-sources/data-source-context");
const account_schema_1 = require("./schemas/account.schema");
const contact_schema_1 = require("./schemas/contact.schema");
const deal_schema_1 = require("./schemas/deal.schema");
const note_schema_1 = require("./schemas/note.schema");
const quote_schema_1 = require("./schemas/quote.schema");
const tag_schema_1 = require("./schemas/tag.schema");
let CrmService = class CrmService {
    constructor(contactModel, accountModel, dealModel, quoteModel, noteModel, tagModel) {
        this.contactModel = contactModel;
        this.accountModel = accountModel;
        this.dealModel = dealModel;
        this.quoteModel = quoteModel;
        this.noteModel = noteModel;
        this.tagModel = tagModel;
    }
    async upsertContact(organizationId, data) {
        const contactId = data.contact_id;
        const email = data.email;
        const phone = data.phone;
        const update = {};
        if (data.first_name !== undefined)
            update.firstName = data.first_name;
        if (data.last_name !== undefined)
            update.lastName = data.last_name;
        if (data.name !== undefined)
            update.name = data.name;
        if (email !== undefined)
            update.email = email;
        if (phone !== undefined)
            update.phone = phone;
        if (data.tags !== undefined)
            update.tags = data.tags;
        const nativeSourceId = (0, data_source_context_1.currentDataSourceScope)()?.nativeSourceId;
        const ownSource = nativeSourceId ? { dataSourceId: nativeSourceId } : {};
        const filter = contactId
            ? { _id: contactId, organizationId, ...ownSource }
            : { organizationId, ...ownSource, $or: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] };
        const saved = await this.contactModel.findOneAndUpdate(filter, { $set: { organizationId, ...ownSource, ...update } }, { upsert: true, new: true }).exec();
        return { contact: saved };
    }
    async searchContactsByIds(organizationId, ids) {
        const contacts = await this.contactModel.find({ organizationId, _id: { $in: ids } }).exec();
        return { contacts };
    }
    async listContacts(organizationId, opts) {
        const filter = { organizationId };
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
    async listDeals(organizationId, opts) {
        const filter = { organizationId };
        if (opts.pipelineId)
            filter.pipelineId = opts.pipelineId;
        if (opts.search)
            filter.name = { $regex: opts.search, $options: 'i' };
        const pageLimit = opts.pageLimit ?? 25;
        const skip = opts.offset ?? (opts.page ? (opts.page - 1) * pageLimit : 0);
        const [deal, total] = await Promise.all([
            this.dealModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageLimit).exec(),
            this.dealModel.countDocuments(filter).exec(),
        ]);
        return { total, deal };
    }
    async getNotes(organizationId, contactId, dealId, accountId) {
        const filter = { organizationId, contactId };
        if (dealId)
            filter.dealId = dealId;
        if (accountId)
            filter.accountId = accountId;
        return this.noteModel.find(filter).sort({ createdAt: -1 }).exec();
    }
    async listTags(organizationId, opts) {
        const filter = { organizationId, moduleName: opts.moduleName ?? 'contact' };
        if (opts.name)
            filter.name = { $regex: opts.name, $options: 'i' };
        const tags = await this.tagModel
            .find(filter)
            .skip(opts.offset ?? 0)
            .limit(opts.limit ?? 25)
            .exec();
        return { tags };
    }
    async listAccounts(organizationId, opts) {
        const filter = { organizationId };
        if (opts.name)
            filter.name = { $regex: opts.name, $options: 'i' };
        const data = await this.accountModel
            .find(filter)
            .skip(opts.offset ?? 0)
            .limit(opts.limit ?? 25)
            .exec();
        return { data };
    }
    listProducts(_organizationId) {
        return { count: 0, product: [] };
    }
    async listQuotes(organizationId, opts) {
        const filter = { organizationId };
        if (opts.dealId)
            filter.dealId = opts.dealId;
        if (opts.search)
            filter.quoteName = { $regex: opts.search, $options: 'i' };
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
};
exports.CrmService = CrmService;
exports.CrmService = CrmService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(contact_schema_1.Contact.name)),
    __param(1, (0, mongoose_1.InjectModel)(account_schema_1.Account.name)),
    __param(2, (0, mongoose_1.InjectModel)(deal_schema_1.Deal.name)),
    __param(3, (0, mongoose_1.InjectModel)(quote_schema_1.Quote.name)),
    __param(4, (0, mongoose_1.InjectModel)(note_schema_1.Note.name)),
    __param(5, (0, mongoose_1.InjectModel)(tag_schema_1.Tag.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model])
], CrmService);
//# sourceMappingURL=crm.service.js.map