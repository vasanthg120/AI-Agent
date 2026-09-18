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
exports.ListTasksQueryDto = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
class ListTasksQueryDto {
}
exports.ListTasksQueryDto = ListTasksQueryDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['todo', 'in_progress', 'done']),
    __metadata("design:type", String)
], ListTasksQueryDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(DATE, { message: 'dateFrom must be YYYY-MM-DD' }),
    __metadata("design:type", String)
], ListTasksQueryDto.prototype, "dateFrom", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(DATE, { message: 'dateTo must be YYYY-MM-DD' }),
    __metadata("design:type", String)
], ListTasksQueryDto.prototype, "dateTo", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (value === undefined || value === '' ? undefined : value === 'true')),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ListTasksQueryDto.prototype, "mine", void 0);
//# sourceMappingURL=list-tasks-query.dto.js.map