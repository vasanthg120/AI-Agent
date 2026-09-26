import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import FormData from 'form-data';
import { Model } from 'mongoose';
import { catchError, firstValueFrom, of } from 'rxjs';
import { CHAT_AGENTS } from '../chat/agents';
import { CreateAgentRoleDto } from './dto/create-agent-role.dto';
import { UpdateAgentRoleDto } from './dto/update-agent-role.dto';
import { AgentRole, AgentRoleDocument } from './schemas/agent-role.schema';

interface RoleGenerateResult {
  documentId: string;
  chunks: number;
  sourceDocumentName: string;
  name: string;
  department: string;
  description: string;
  systemPrompt: string;
}

// Agent Builder Phase 1's Describe method — same structured fields as
// RoleGenerateResult minus the document-specific ones (documentId/chunks/
// sourceDocumentName), since there's no uploaded file to embed.
interface RoleGenerateFromDescriptionResult {
  name: string;
  department: string;
  description: string;
  systemPrompt: string;
}

// Validated (dataviz skill's scripts/validate_palette.js) against this app's
// real chart surfaces alongside the two static personas' brand colors
// (#ed7e2c/#a85a1e, unchanged) — all 8 pass in light mode; in dark mode only
// the brand orange's lightness-band check fails, an accepted exception since
// that color is fixed app-wide, not just for charts. The one CVD adjacency
// warning (cyan/fuchsia, ΔE 6.5) is in the "legal with secondary encoding"
// band and is covered by the dashboard's agent-comparison chart always
// direct-labeling bars with the agent's name on the x-axis.
const AVATAR_PALETTE = ['#2563eb', '#059669', '#c026d3', '#0891b2', '#9333ea', '#e11d48'];

@Injectable()
export class AgentRolesService {
  private readonly logger = new Logger(AgentRolesService.name);
  private readonly agentUrl: string;

  constructor(
    @InjectModel(AgentRole.name) private roleModel: Model<AgentRoleDocument>,
    private http: HttpService,
    private config: ConfigService,
  ) {
    this.agentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async listAll(organizationId: string) {
    const dynamic = await this.roleModel.find({ organizationId }).sort({ createdAt: -1 }).exec();
    const builtin = CHAT_AGENTS.map((a) => ({
      slug: a.id,
      name: a.name,
      description: a.description,
      avatarColor: a.avatarColor,
      status: 'active' as const,
      builtin: true,
    }));
    return [...builtin, ...dynamic.map((d) => ({ ...d.toObject(), builtin: false }))];
  }

  async generateDraft(userId: string, organizationId: string, userJwt: string, file: Express.Multer.File) {
    const form = new FormData();
    form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
    form.append('user_id', userId);

    const { data } = await firstValueFrom(
      this.http.post<RoleGenerateResult>(`${this.agentUrl}/roles/generate`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${userJwt}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }),
    );

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

  // Agent Builder Phase 1's Describe method — same structured-output shape
  // as generateDraft, just no file/Qdrant document involved (no
  // sourceDocumentName/sourceDocumentId on the created role).
  async generateFromDescription(userId: string, organizationId: string, description: string) {
    const { data } = await firstValueFrom(
      this.http.post<RoleGenerateFromDescriptionResult>(`${this.agentUrl}/roles/generate-from-description`, {
        description,
        user_id: userId,
      }),
    );

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

  // Agent Builder Phase 1's Manual and Template methods — no AI call, no
  // file. Template is purely a frontend concept (a constant pre-filling
  // this same payload shape); the backend has no notion of "template".
  async createManual(userId: string, organizationId: string, dto: CreateAgentRoleDto) {
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

  async update(id: string, dto: UpdateAgentRoleDto, userJwt: string, organizationId: string) {
    const existing = await this.roleModel.findOne({ _id: id, organizationId }).exec();
    if (!existing) throw new NotFoundException('Role not found');

    const activating = dto.status === 'active' && existing.status !== 'active';
    // dto's optional class fields are own `undefined` properties (TS target
    // ES2022's useDefineForClassFields) even when absent from the request
    // body — a plain Object.assign would null out every field the caller
    // didn't send. Only copy fields the caller actually provided.
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) (existing as unknown as Record<string, unknown>)[key] = value;
    }
    await existing.save();

    // Manual/Template/Describe-created roles have no source document (no
    // Qdrant point to publish) — nothing to do for those on activation.
    if (activating && existing.sourceDocumentId) {
      await firstValueFrom(
        this.http
          .post(
            `${this.agentUrl}/roles/publish-source`,
            { documentId: existing.sourceDocumentId },
            { headers: { Authorization: `Bearer ${userJwt}` } },
          )
          .pipe(
            catchError((err: Error) => {
              this.logger.error(`Failed to publish source document for role ${id}: ${err.message}`);
              return of(null);
            }),
          ),
      );
    }
    return { ...existing.toObject(), builtin: false };
  }

  async remove(id: string, userJwt: string, organizationId: string) {
    const existing = await this.roleModel.findOne({ _id: id, organizationId }).exec();
    if (!existing) throw new NotFoundException('Role not found');

    // Best-effort — don't block deleting the role's metadata on Qdrant
    // cleanup. Skipped entirely for a Manual/Template/Describe-created role,
    // which has no source document to discard.
    if (existing.sourceDocumentId) {
      await firstValueFrom(
        this.http
          .post(
            `${this.agentUrl}/roles/discard-source`,
            { documentId: existing.sourceDocumentId },
            { headers: { Authorization: `Bearer ${userJwt}` } },
          )
          .pipe(
            catchError((err: Error) => {
              this.logger.error(`Failed to discard source document for role ${id}: ${err.message}`);
              return of(null);
            }),
          ),
      );
    }
    await existing.deleteOne();
    return { deleted: true };
  }

  private async newRoleDefaults(name: string, organizationId: string): Promise<{ slug: string; avatarColor: string }> {
    const slug = await this.uniqueSlug(name, organizationId);
    const avatarColor = AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)];
    return { slug, avatarColor };
  }

  private async uniqueSlug(name: string, organizationId: string): Promise<string> {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
    const taken = new Set<string>([
      ...CHAT_AGENTS.map((a) => a.id),
      ...(await this.roleModel.distinct('slug', { organizationId }).exec()),
    ]);
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${base}_${n++}`;
    }
    return candidate;
  }
}
