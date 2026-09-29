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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var AgentRolesService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRolesService = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const mongoose_1 = require("@nestjs/mongoose");
const form_data_1 = __importDefault(require("form-data"));
const mongoose_2 = require("mongoose");
const rxjs_1 = require("rxjs");
const agents_1 = require("../chat/agents");
const agent_role_schema_1 = require("./schemas/agent-role.schema");
const AVATAR_PALETTE = ['#2563eb', '#059669', '#c026d3', '#0891b2', '#9333ea', '#e11d48'];
let AgentRolesService = AgentRolesService_1 = class AgentRolesService {
    constructor(roleModel, http, config) {
        this.roleModel = roleModel;
        this.http = http;
        this.config = config;
        this.logger = new common_1.Logger(AgentRolesService_1.name);
        this.agentUrl = this.config.get('pythonAgentUrl') ?? 'http://localhost:8000';
    }
    async listAll(organizationId) {
        const dynamic = await this.roleModel.find({ organizationId }).sort({ createdAt: -1 }).exec();
        const builtin = agents_1.CHAT_AGENTS.map((a) => ({
            slug: a.id,
            name: a.name,
            description: a.description,
            avatarColor: a.avatarColor,
            status: 'active',
            builtin: true,
        }));
        return [...builtin, ...dynamic.map((d) => ({ ...d.toObject(), builtin: false }))];
    }
    async generateDraft(userId, organizationId, userJwt, file) {
        const form = new form_data_1.default();
        form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
        form.append('user_id', userId);
        const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.agentUrl}/roles/generate`, form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${userJwt}` },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        }));
        const { slug, avatarColor } = await this.newRoleDefaults(data.name, organizationId);
        const created = await this.roleModel.create({
            organizationId,
            slug,
            name: data.name,
            department: data.department,
            description: data.description,
            systemPrompt: data.systemPrompt,
            sourceDocumentName: data.sourceDocumentName,
            sourceDocumentId: data.documentId,
            status: 'draft',
            avatarColor,
            createdBy: userId,
        });
        return { ...created.toObject(), builtin: false };
    }
    async generateFromDescription(userId, organizationId, description) {
        const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.agentUrl}/roles/generate-from-description`, {
            description,
            user_id: userId,
        }));
        const { slug, avatarColor } = await this.newRoleDefaults(data.name, organizationId);
        const created = await this.roleModel.create({
            organizationId,
            slug,
            name: data.name,
            department: data.department,
            description: data.description,
            systemPrompt: data.systemPrompt,
            status: 'draft',
            avatarColor,
            createdBy: userId,
        });
        return { ...created.toObject(), builtin: false };
    }
    async createManual(userId, organizationId, dto) {
        const { slug, avatarColor } = await this.newRoleDefaults(dto.name, organizationId);
        const created = await this.roleModel.create({
            organizationId,
            slug,
            name: dto.name,
            department: dto.department ?? '',
            description: dto.description ?? '',
            systemPrompt: dto.systemPrompt,
            assignedDepartments: dto.assignedDepartments ?? [],
            assignedUserIds: dto.assignedUserIds ?? [],
            allowedTools: dto.allowedTools ?? [],
            modelTier: dto.modelTier ?? undefined,
            status: 'draft',
            avatarColor,
            createdBy: userId,
        });
        return { ...created.toObject(), builtin: false };
    }
    async update(id, dto, userJwt, organizationId) {
        const existing = await this.roleModel.findOne({ _id: id, organizationId }).exec();
        if (!existing)
            throw new common_1.NotFoundException('Role not found');
        const activating = dto.status === 'active' && existing.status !== 'active';
        for (const [key, value] of Object.entries(dto)) {
            if (value !== undefined)
                existing[key] = value;
        }
        await existing.save();
        if (activating && existing.sourceDocumentId) {
            await (0, rxjs_1.firstValueFrom)(this.http
                .post(`${this.agentUrl}/roles/publish-source`, { documentId: existing.sourceDocumentId }, { headers: { Authorization: `Bearer ${userJwt}` } })
                .pipe((0, rxjs_1.catchError)((err) => {
                this.logger.error(`Failed to publish source document for role ${id}: ${err.message}`);
                return (0, rxjs_1.of)(null);
            })));
        }
        return { ...existing.toObject(), builtin: false };
    }
    async remove(id, userJwt, organizationId) {
        const existing = await this.roleModel.findOne({ _id: id, organizationId }).exec();
        if (!existing)
            throw new common_1.NotFoundException('Role not found');
        if (existing.sourceDocumentId) {
            await (0, rxjs_1.firstValueFrom)(this.http
                .post(`${this.agentUrl}/roles/discard-source`, { documentId: existing.sourceDocumentId }, { headers: { Authorization: `Bearer ${userJwt}` } })
                .pipe((0, rxjs_1.catchError)((err) => {
                this.logger.error(`Failed to discard source document for role ${id}: ${err.message}`);
                return (0, rxjs_1.of)(null);
            })));
        }
        await existing.deleteOne();
        return { deleted: true };
    }
    async newRoleDefaults(name, organizationId) {
        const slug = await this.uniqueSlug(name, organizationId);
        const avatarColor = AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)];
        return { slug, avatarColor };
    }
    async uniqueSlug(name, organizationId) {
        const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
        const taken = new Set([
            ...agents_1.CHAT_AGENTS.map((a) => a.id),
            ...(await this.roleModel.distinct('slug', { organizationId }).exec()),
        ]);
        let candidate = base;
        let n = 2;
        while (taken.has(candidate)) {
            candidate = `${base}_${n++}`;
        }
        return candidate;
    }
};
exports.AgentRolesService = AgentRolesService;
exports.AgentRolesService = AgentRolesService = AgentRolesService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(agent_role_schema_1.AgentRole.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        axios_1.HttpService,
        config_1.ConfigService])
], AgentRolesService);
//# sourceMappingURL=agent-roles.service.js.map