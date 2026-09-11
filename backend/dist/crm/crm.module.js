"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrmModule = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const auth_module_1 = require("../auth/auth.module");
const billing_module_1 = require("../billing/billing.module");
const dashboard_module_1 = require("../dashboard/dashboard.module");
const organizations_module_1 = require("../organizations/organizations.module");
const timeline_module_1 = require("../timeline/timeline.module");
const users_module_1 = require("../users/users.module");
const account_schema_1 = require("./schemas/account.schema");
const contact_schema_1 = require("./schemas/contact.schema");
const customer_activity_summary_schema_1 = require("./schemas/customer-activity-summary.schema");
const customer_activity_personal_summary_schema_1 = require("./schemas/customer-activity-personal-summary.schema");
const deal_schema_1 = require("./schemas/deal.schema");
const deal_owner_mapping_schema_1 = require("./schemas/deal-owner-mapping.schema");
const email_intelligence_item_schema_1 = require("../email-intelligence/schemas/email-intelligence-item.schema");
const note_schema_1 = require("./schemas/note.schema");
const product_schema_1 = require("./schemas/product.schema");
const quote_schema_1 = require("./schemas/quote.schema");
const quote_counter_schema_1 = require("./schemas/quote-counter.schema");
const quote_payment_schema_1 = require("./schemas/quote-payment.schema");
const sales_target_schema_1 = require("./schemas/sales-target.schema");
const tag_schema_1 = require("./schemas/tag.schema");
const business_dashboard_controller_1 = require("./business-dashboard.controller");
const business_dashboard_service_1 = require("./business-dashboard.service");
const crm_controller_1 = require("./crm.controller");
const crm_service_1 = require("./crm.service");
const customer_activity_controller_1 = require("./customer-activity.controller");
const customer_activity_service_1 = require("./customer-activity.service");
const quotes_controller_1 = require("./quotes.controller");
const products_controller_1 = require("./products.controller");
const products_service_1 = require("./products.service");
const deal_performance_dashboard_service_1 = require("./deal-performance-dashboard.service");
const deals_controller_1 = require("./deals.controller");
const deals_export_service_1 = require("./deals-export.service");
const deals_service_1 = require("./deals.service");
const deal_owner_mapping_service_1 = require("./deal-owner-mapping.service");
const quote_payments_service_1 = require("./quote-payments.service");
const quotes_service_1 = require("./quotes.service");
const sales_analytics_service_1 = require("./sales-analytics.service");
const sales_target_controller_1 = require("./sales-target.controller");
let CrmModule = class CrmModule {
};
exports.CrmModule = CrmModule;
exports.CrmModule = CrmModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([
                { name: contact_schema_1.Contact.name, schema: contact_schema_1.ContactSchema },
                { name: account_schema_1.Account.name, schema: account_schema_1.AccountSchema },
                { name: deal_schema_1.Deal.name, schema: deal_schema_1.DealSchema },
                { name: deal_owner_mapping_schema_1.DealOwnerMapping.name, schema: deal_owner_mapping_schema_1.DealOwnerMappingSchema },
                { name: quote_schema_1.Quote.name, schema: quote_schema_1.QuoteSchema },
                { name: quote_payment_schema_1.QuotePayment.name, schema: quote_payment_schema_1.QuotePaymentSchema },
                { name: note_schema_1.Note.name, schema: note_schema_1.NoteSchema },
                { name: product_schema_1.Product.name, schema: product_schema_1.ProductSchema },
                { name: tag_schema_1.Tag.name, schema: tag_schema_1.TagSchema },
                { name: sales_target_schema_1.SalesTarget.name, schema: sales_target_schema_1.SalesTargetSchema },
                { name: quote_counter_schema_1.QuoteCounter.name, schema: quote_counter_schema_1.QuoteCounterSchema },
                { name: customer_activity_summary_schema_1.CustomerActivitySummary.name, schema: customer_activity_summary_schema_1.CustomerActivitySummarySchema },
                { name: customer_activity_personal_summary_schema_1.CustomerActivityPersonalSummary.name, schema: customer_activity_personal_summary_schema_1.CustomerActivityPersonalSummarySchema },
                { name: email_intelligence_item_schema_1.EmailIntelligenceItem.name, schema: email_intelligence_item_schema_1.EmailIntelligenceItemSchema },
            ]),
            dashboard_module_1.DashboardModule,
            organizations_module_1.OrganizationsModule,
            users_module_1.UsersModule,
            auth_module_1.AuthModule,
            billing_module_1.BillingModule,
            timeline_module_1.TimelineModule,
            axios_1.HttpModule.register({ timeout: 60_000 }),
        ],
        controllers: [
            crm_controller_1.CrmController,
            sales_target_controller_1.SalesTargetController,
            business_dashboard_controller_1.BusinessDashboardController,
            deals_controller_1.DealsController,
            customer_activity_controller_1.CustomerActivityController,
            quotes_controller_1.QuotesController,
            products_controller_1.ProductsController,
        ],
        providers: [
            crm_service_1.CrmService,
            sales_analytics_service_1.SalesAnalyticsService,
            business_dashboard_service_1.BusinessDashboardService,
            deals_service_1.DealsService,
            deals_export_service_1.DealsExportService,
            deal_owner_mapping_service_1.DealOwnerMappingService,
            deal_performance_dashboard_service_1.DealPerformanceDashboardService,
            customer_activity_service_1.CustomerActivityService,
            quotes_service_1.QuotesService,
            quote_payments_service_1.QuotePaymentsService,
            products_service_1.ProductsService,
        ],
        exports: [
            customer_activity_service_1.CustomerActivityService,
            quotes_service_1.QuotesService,
            quote_payments_service_1.QuotePaymentsService,
            business_dashboard_service_1.BusinessDashboardService,
            deal_performance_dashboard_service_1.DealPerformanceDashboardService,
            sales_analytics_service_1.SalesAnalyticsService,
        ],
    })
], CrmModule);
//# sourceMappingURL=crm.module.js.map