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
exports.CrmController = void 0;
const common_1 = require("@nestjs/common");
const current_user_decorator_1 = require("../common/decorators/current-user.decorator");
const jwt_auth_guard_1 = require("../common/guards/jwt-auth.guard");
const crm_service_1 = require("./crm.service");
const permission_decorator_1 = require("../common/permissions/permission.decorator");
let CrmController = class CrmController {
    constructor(crmService) {
        this.crmService = crmService;
    }
    upsertContact(user, body) {
        return this.crmService.upsertContact(user.organizationId, body.data ?? {});
    }
    searchContactsByIds(user, body) {
        return this.crmService.searchContactsByIds(user.organizationId, body.ids ?? []);
    }
    listContacts(user, body) {
        return this.crmService.listContacts(user.organizationId, {
            searchAfter: body.search_after,
            limit: body.limit,
            searchText: body.search_text,
        });
    }
    listDeals(user, body) {
        return this.crmService.listDeals(user.organizationId, {
            page: body.page,
            offset: body.offset,
            pageLimit: body.page_limit,
            search: body.search,
            pipelineId: body.pipelineId,
        });
    }
    getNotes(user, body) {
        return this.crmService.getNotes(user.organizationId, body.contact_id, body.deal_ids?.[0], body.account_ids?.[0]);
    }
    listTags(user, body) {
        return this.crmService.listTags(user.organizationId, {
            name: body.name,
            moduleName: body.module_name,
            limit: body.limit,
            offset: body.offset,
        });
    }
    listAccounts(user, body) {
        return this.crmService.listAccounts(user.organizationId, body);
    }
    listProducts(user) {
        return this.crmService.listProducts(user.organizationId);
    }
    listQuotes(user, body) {
        return this.crmService.listQuotes(user.organizationId, {
            search: body.search,
            dealId: body.deal_id,
            limit: body.limit,
            startAfter: body.startAfter,
        });
    }
};
exports.CrmController = CrmController;
__decorate([
    (0, common_1.Post)('contact/upsert'),
    (0, permission_decorator_1.Permission)('customers', 'create'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "upsertContact", null);
__decorate([
    (0, common_1.Post)('contact/search/contact-by-ids'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "searchContactsByIds", null);
__decorate([
    (0, common_1.Post)('contact/search/contact'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "listContacts", null);
__decorate([
    (0, common_1.Post)('deal/getDealsByBusinessId'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "listDeals", null);
__decorate([
    (0, common_1.Post)('note/getNotes'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "getNotes", null);
__decorate([
    (0, common_1.Post)('tag/fetchTagList'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "listTags", null);
__decorate([
    (0, common_1.Post)('account/fetch-account-list'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "listAccounts", null);
__decorate([
    (0, common_1.Post)('product/get-product-by-pagination'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "listProducts", null);
__decorate([
    (0, common_1.Post)('quotes/getQuotes'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], CrmController.prototype, "listQuotes", null);
exports.CrmController = CrmController = __decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, permission_decorator_1.Permission)('customers', 'view'),
    (0, common_1.Controller)('crm'),
    __metadata("design:paramtypes", [crm_service_1.CrmService])
], CrmController);
//# sourceMappingURL=crm.controller.js.map