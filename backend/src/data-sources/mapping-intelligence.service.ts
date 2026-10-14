import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ReservationService } from '../billing/reservation.service';
import { RawRecord, fieldPaths, getPath, mapStatus, nameScore, parseDate, toCanonical, toDay, toNumber, withDisplayName } from './canonical-mapping';
import { DataSourcesService } from './data-sources.service';
import { CANONICAL_FIELDS, CRM_PROVIDERS, FieldMappings, MirroredModule, StatusMapping } from './provider-catalog';

export type MappingMethod = 'saved' | 'auto' | 'ai' | 'none';

export interface FieldSuggestion {
  key: string;
  label: string;
  hint: string;
  // Without a record id nothing of this kind can be told apart, so nothing syncs.
  required: boolean;
  source: string | null;
  // 0-100: how sure HaiVE is that `source` holds this. 100 only for a mapping a person saved.
  confidence: number;
  method: MappingMethod;
  needsReview: boolean;
  reason: string;
  // A value of `source` from one of the CRM's own records, so a person can judge the match.
  example?: string;
}

export interface ModuleSuggestion {
  module: MirroredModule;
  fields: FieldSuggestion[];
  sourceFields: { path: string; example?: string }[];
  samples: number;
}

export interface MappingPreviewRow {
  module: MirroredModule;
  values: Record<string, string | number | null>;
  problems: string[];
}

// Below this, a match is shown for review instead of being treated as settled.
const REVIEW_BELOW = 85;
// The AI is only asked about fields a name match left open or unsure.
const ASK_AI_BELOW = 85;
const MIRRORED: MirroredModule[] = ['deals', 'quotes', 'contacts', 'accounts'];

const display = (value: unknown): string | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/** Does a field's example look like what the HaiVE field holds? Nudges a name match up or down. */
function shapeBonus(key: string, value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim();
  if (key === 'email' || key === 'customerEmail') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? 5 : -30;
  if (key === 'amount') return Number.isFinite(Number(text.replace(/[^0-9.-]/g, ''))) && /\d/.test(text) ? 4 : -30;
  if (key === 'closeDate' || key === 'createdAt' || key === 'expirationDate') return parseDate(text) && /\d{4}|\d{9,}/.test(text) ? 4 : -25;
  if (key === 'phone' || key === 'customerPhone') return /^[+\d][\d\s\-()]{5,}$/.test(text) ? 4 : -20;
  if (key === 'externalId') return typeof value === 'object' ? -40 : 2;
  return 0;
}

// Field mapping, made understandable: for every HaiVE field, which of the
// CRM's own fields holds it, how sure HaiVE is and why — from the saved
// mapping, from the field names and example values (no AI), and, when asked,
// from the AI for whatever is still open. Suggestions never change a mapping
// by themselves: a person reviews and saves, and every saved mapping keeps
// the one it replaced (versions), so a bad change can be undone.
@Injectable()
export class MappingIntelligenceService {
  private readonly logger = new Logger(MappingIntelligenceService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectConnection() private connection: Connection,
    private dataSources: DataSourcesService,
    private reservations: ReservationService,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private async source(organizationId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Data source not found.');
    const source = await this.connection.collection('crm_data_sources').findOne({ _id: new Types.ObjectId(id), organizationId });
    if (!source) throw new NotFoundException('Data source not found.');
    return source;
  }

  private async samples(organizationId: string, sourceId: string): Promise<Map<MirroredModule, RawRecord[]>> {
    const rows = await this.connection.collection('crm_source_samples').find({ organizationId, dataSourceId: sourceId }).toArray();
    return new Map(rows.map((r) => [r.module as MirroredModule, ((r.records as RawRecord[]) ?? []).map((record) => withDisplayName(record))]));
  }

  /** Suggested mapping for every module the source provides. `ai` also asks the AI about what's still unsure (uses credits). */
  async suggest(caller: JwtPayload, sourceId: string, ai: boolean): Promise<{ modules: ModuleSuggestion[]; reviewCount: number; aiUsed: boolean }> {
    const organizationId = caller.organizationId;
    const source = await this.source(organizationId, sourceId);
    const samples = await this.samples(organizationId, sourceId);
    const saved = (source.fieldMappings ?? {}) as FieldMappings;
    const modules: ModuleSuggestion[] = [];

    for (const module of MIRRORED.filter((m) => ((source.modules as string[]) ?? []).includes(m))) {
      const records = samples.get(module) ?? [];
      const paths = new Set<string>(((source.availableFields as Record<string, string[]> | undefined)?.[module] ?? []).filter((p) => typeof p === 'string'));
      for (const record of records) for (const path of fieldPaths(record)) paths.add(path);
      const exampleOf = (path: string) => records.map((r) => getPath(r, path)).find((v) => v !== null && v !== undefined && v !== '');
      const sourceFields = [...paths].sort().map((path) => ({ path, example: display(exampleOf(path)) }));
      const taken = new Set(Object.values(saved[module] ?? {}));

      const fields = CANONICAL_FIELDS[module].map((field): FieldSuggestion => {
        const base = { key: field.key, label: field.label, hint: field.hint, required: field.key === 'externalId' };
        const current = saved[module]?.[field.key];
        if (current) {
          // A saved mapping stands — but say so when the CRM no longer sends that field.
          const missing = paths.size > 0 && !paths.has(current);
          return {
            ...base,
            source: current,
            confidence: missing ? 40 : 100,
            method: 'saved',
            needsReview: missing,
            reason: missing ? 'This field wasn’t in the records HaiVE last read — check it still exists.' : 'Saved mapping.',
            example: display(exampleOf(current)),
          };
        }
        // Best candidate by name, adjusted by whether its values look right.
        let best: { path: string; score: number } | null = null;
        for (const path of paths) {
          if (taken.has(path)) continue;
          const score = nameScore(field.key, path);
          if (score <= 0) continue;
          const adjusted = Math.max(0, Math.min(97, score + shapeBonus(field.key, exampleOf(path))));
          if (!best || adjusted > best.score) best = { path, score: adjusted };
        }
        if (best && best.score >= 50) {
          return {
            ...base,
            source: best.path,
            confidence: best.score,
            method: 'auto',
            needsReview: best.score < REVIEW_BELOW,
            reason: best.score >= REVIEW_BELOW ? 'The field name and its values match.' : 'The name is similar — please confirm.',
            example: display(exampleOf(best.path)),
          };
        }
        return {
          ...base,
          source: null,
          confidence: 0,
          method: 'none',
          needsReview: base.required,
          reason: paths.size ? 'No field with a matching name was found.' : 'No records have been read yet.',
        };
      });
      modules.push({ module, fields, sourceFields, samples: records.length });
    }

    let aiUsed = false;
    if (ai) {
      for (const entry of modules) {
        const open = entry.fields.filter((f) => f.method !== 'saved' && f.confidence < ASK_AI_BELOW);
        if (open.length === 0 || entry.sourceFields.length === 0) continue;
        const answers = await this.askAi(caller, String(source.provider), entry, open);
        aiUsed = true;
        const valid = new Set(entry.sourceFields.map((s) => s.path));
        const used = new Set(entry.fields.filter((f) => f.source && f.confidence >= ASK_AI_BELOW).map((f) => f.source!));
        for (const answer of answers) {
          const field = entry.fields.find((f) => f.key === answer.target);
          // Only a real field of this CRM, not already used, and only when the AI is surer than the name match was.
          if (!field || !answer.source || !valid.has(answer.source) || used.has(answer.source)) continue;
          const confidence = Math.max(0, Math.min(95, Math.round(Number(answer.confidence) || 0)));
          if (confidence <= field.confidence) continue;
          Object.assign(field, {
            source: answer.source,
            confidence,
            method: 'ai' as const,
            needsReview: confidence < REVIEW_BELOW,
            reason: String(answer.reason ?? 'Suggested by AI.').slice(0, 160),
            example: entry.sourceFields.find((s) => s.path === answer.source)?.example,
          });
          used.add(answer.source);
        }
      }
    }
    return { modules, reviewCount: modules.reduce((n, m) => n + m.fields.filter((f) => f.needsReview).length, 0), aiUsed };
  }

  private async askAi(caller: JwtPayload, provider: string, entry: ModuleSuggestion, open: FieldSuggestion[]) {
    const requestId = randomUUID();
    await this.reservations.reserve(this.reservations.resolveTenantKey(caller.organizationId, caller.sub), caller.sub, requestId, 'crm-mapping-suggest');
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId: caller.organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<{ mappings: { target: string; source: string | null; confidence: number; reason: string }[] }>(
          `${this.pythonAgentUrl}/sync/crm/suggest-mapping`,
          {
            crm: CRM_PROVIDERS[provider as keyof typeof CRM_PROVIDERS]?.label ?? provider,
            recordType: entry.module,
            targetFields: open.map((f) => ({ key: f.key, meaning: `${f.label} — ${f.hint}` })),
            crmFields: entry.sourceFields.slice(0, 200),
            request_id: requestId,
          },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 90_000 },
        ),
      );
      await this.reservations.settle(requestId);
      return data.mappings ?? [];
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`AI mapping suggestion failed: ${(err as Error).message}`);
      throw new BadRequestException('The AI couldn’t suggest a mapping right now. You can still map the fields yourself.');
    }
  }

  /** What a mapping can't be saved with. Empty = fine. */
  validate(fieldMappings: FieldMappings, modules: string[]): string[] {
    const problems: string[] = [];
    for (const module of MIRRORED.filter((m) => modules.includes(m))) {
      const mapping = fieldMappings[module] ?? {};
      const mapped = Object.entries(mapping).filter(([, path]) => !!path);
      if (mapped.length > 0 && !mapping.externalId) {
        problems.push(`Choose the Record ID field for ${module} — without it HaiVE can’t tell one record from another.`);
      }
      const seen = new Map<string, string>();
      for (const [key, path] of mapped) {
        // The same CRM field feeding status and stage is normal (many CRMs have one); anything else is a slip.
        const other = seen.get(path);
        if (other && !(['status', 'stage'].includes(key) && ['status', 'stage'].includes(other))) {
          problems.push(`“${path}” is mapped to two ${module} fields (${other} and ${key}). Each CRM field should feed one HaiVE field.`);
        }
        seen.set(path, key);
      }
    }
    return problems;
  }

  /** The CRM's own sample records as HaiVE would store them under `fieldMappings` (the saved mapping when omitted). */
  async preview(organizationId: string, sourceId: string, fieldMappings?: FieldMappings, statusMapping?: StatusMapping) {
    const source = await this.source(organizationId, sourceId);
    const samples = await this.samples(organizationId, sourceId);
    const mappings = fieldMappings ?? ((source.fieldMappings ?? {}) as FieldMappings);
    const statuses = statusMapping ?? (source.statusMapping as StatusMapping | undefined);
    const rows: MappingPreviewRow[] = [];
    for (const module of MIRRORED.filter((m) => ((source.modules as string[]) ?? []).includes(m))) {
      const mapping = mappings[module] ?? {};
      for (const record of (samples.get(module) ?? []).slice(0, 3)) {
        const c = toCanonical(record, mapping);
        const problems: string[] = [];
        if (!mapping.externalId) problems.push('No Record ID field is mapped.');
        else if (c.externalId === undefined || c.externalId === null || c.externalId === '')
          problems.push(`This record has no “${mapping.externalId}”, so it would be skipped.`);
        const values: Record<string, string | number | null> = {};
        for (const field of CANONICAL_FIELDS[module]) {
          if (!mapping[field.key]) continue;
          const raw = c[field.key];
          if (field.key === 'amount') values[field.label] = raw === undefined || raw === null || raw === '' ? null : toNumber(raw);
          else if (field.key === 'status' && module === 'deals') values[field.label] = `${mapStatus(raw, statuses)}${raw ? ` (from “${String(raw)}”)` : ''}`;
          else if (field.key === 'closeDate' || field.key === 'expirationDate')
            values[field.label] = toDay(raw) ?? (raw ? `“${String(raw)}” isn’t a date` : null);
          else values[field.label] = display(raw) ?? null;
          if (field.key === 'amount' && raw && !/\d/.test(String(raw))) problems.push(`Value “${String(raw)}” isn’t a number.`);
        }
        rows.push({ module, values, problems });
      }
    }
    return { rows, problems: this.validate(mappings, (source.modules as string[]) ?? []), sampleCount: rows.length };
  }

  // ---- versions ---------------------------------------------------------------------

  /** Saves a reviewed mapping: validated first, the mapping it replaces kept as a version. */
  async save(caller: JwtPayload, sourceId: string, fieldMappings: FieldMappings, statusMapping?: StatusMapping) {
    const source = await this.source(caller.organizationId, sourceId);
    const problems = this.validate(fieldMappings, (source.modules as string[]) ?? []);
    if (problems.length) throw new BadRequestException(problems[0]);
    const versions = this.connection.collection('crm_mapping_versions');
    const last = await versions.find({ organizationId: caller.organizationId, dataSourceId: sourceId }).sort({ version: -1 }).limit(1).toArray();
    await versions.insertOne({
      organizationId: caller.organizationId,
      dataSourceId: sourceId,
      version: (last[0]?.version ?? 0) + 1,
      // What was in effect until now — restoring a version puts this back.
      fieldMappings: source.fieldMappings ?? {},
      statusMapping: source.statusMapping ?? { won: [], lost: [] },
      replacedAt: new Date(),
      replacedBy: caller.sub,
    });
    return this.dataSources.update(caller.organizationId, sourceId, { fieldMappings, ...(statusMapping ? { statusMapping } : {}) });
  }

  async versions(organizationId: string, sourceId: string) {
    await this.source(organizationId, sourceId);
    const rows = await this.connection
      .collection('crm_mapping_versions')
      .find({ organizationId, dataSourceId: sourceId })
      .sort({ version: -1 })
      .limit(20)
      .toArray();
    return rows.map((r) => ({
      version: r.version as number,
      replacedAt: r.replacedAt as Date,
      fieldCount: Object.values((r.fieldMappings ?? {}) as FieldMappings).reduce((n, m) => n + Object.keys(m ?? {}).length, 0),
    }));
  }

  async restore(caller: JwtPayload, sourceId: string, version: number) {
    const row = await this.connection.collection('crm_mapping_versions').findOne({ organizationId: caller.organizationId, dataSourceId: sourceId, version });
    if (!row) throw new NotFoundException('That version no longer exists.');
    return this.save(caller, sourceId, (row.fieldMappings ?? {}) as FieldMappings, row.statusMapping as StatusMapping | undefined);
  }
}
