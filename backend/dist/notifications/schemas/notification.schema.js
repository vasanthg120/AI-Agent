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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationSchema = exports.Notification = exports.NOTIFICATION_ENTITY_TYPES = exports.NOTIFICATION_KINDS = void 0;
const mongoose_1 = require("@nestjs/mongoose");
exports.NOTIFICATION_KINDS = ['system', 'integration', 'warning', 'error', 'sla_breach'];
exports.NOTIFICATION_ENTITY_TYPES = [
    'email',
    'financeDocument',
    'deal',
    'task',
    'outlookAccount',
    'dailyReport',
];
let Notification = class Notification {
};
exports.Notification = Notification;
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], Notification.prototype, "userId", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], Notification.prototype, "organizationId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, enum: exports.NOTIFICATION_KINDS }),
    __metadata("design:type", String)
], Notification.prototype, "kind", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], Notification.prototype, "title", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], Notification.prototype, "description", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: false }),
    __metadata("design:type", Boolean)
], Notification.prototype, "read", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], Notification.prototype, "source", void 0);
__decorate([
    (0, mongoose_1.Prop)({ enum: exports.NOTIFICATION_ENTITY_TYPES }),
    __metadata("design:type", String)
], Notification.prototype, "entityType", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], Notification.prototype, "entityId", void 0);
exports.Notification = Notification = __decorate([
    (0, mongoose_1.Schema)({ timestamps: true, collection: 'notifications' })
], Notification);
exports.NotificationSchema = mongoose_1.SchemaFactory.createForClass(Notification);
//# sourceMappingURL=notification.schema.js.map