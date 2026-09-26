import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AgentRoleDocument = AgentRole & Document<Types.ObjectId>;

// Agent Builder redesign — the fixed Role Category options `department`
// below is constrained to (frontend-facing label "Role Category"). Drives
// progressive disclosure (suggested tools/knowledge) in the creation wizard;
// 'custom' means no preset applies. Kept as a plain string column (not a
// Mongo enum) so a future category can be added without a migration —
// validated at the DTO layer instead (@IsIn(ROLE_CATEGORIES)).
export const ROLE_CATEGORIES = ['sales', 'finance', 'hr', 'support', 'marketing', 'operations', 'custom'] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

// Dynamically-generated AI personas (Dynamic Role Generator). NestJS owns all
// writes to this collection; python-agent reads it directly (read-only) to
// resolve a persona's system prompt — see personas.py's resolve_system_prompt.
@Schema({ timestamps: true, collection: 'agent_roles' })
export class AgentRole {
  // The tenant this dynamically-generated persona belongs to — without this,
  // every org would see (and could @mention) every other org's custom AI
  // roles. python-agent's personas.py also needs this once it resolves a
  // persona for a specific org's conversation (see Phase 5 in the roadmap).
  @Prop({ required: true, index: true })
  organizationId: string;

  // Stable id used as agent_id everywhere else (chat's @mention, personas.py
  // lookup) — distinct from Mongo's own _id, which is only used for this
  // module's own CRUD routing (PATCH/DELETE /agent-roles/:id). Unique per
  // org, not globally — two tenants can each have their own "sales_lead".
  @Prop({ required: true, index: true })
  slug: string;

  @Prop({ required: true }) name: string;
  // Role Category (see ROLE_CATEGORIES above) — was a free-text "Department"
  // label with no runtime effect; now drives the creation wizard's
  // suggested tools/knowledge. Stored value is one of ROLE_CATEGORIES,
  // validated at the DTO layer, not here.
  @Prop({ default: '' }) department: string;
  @Prop({ default: '' }) description: string;

  @Prop({ required: true }) systemPrompt: string;

  // Both unset for a role created via Template/Describe/Manual (Agent
  // Builder Phase 1) — those creation methods have no uploaded document at
  // all. AgentRolesService.update()/remove() must skip the publish-source/
  // discard-source calls to python-agent when sourceDocumentId is absent.
  @Prop() sourceDocumentName?: string;
  // Qdrant document_id for the embedded source doc — used to call
  // python-agent's /roles/publish-source (on activate) and
  // /roles/discard-source (on delete).
  @Prop() sourceDocumentId?: string;

  @Prop({ enum: ['draft', 'active'], default: 'draft', index: true })
  status: 'draft' | 'active';

  // Chat @mention visibility (Phase 6, Agent Marketplace). Both empty (the
  // default) = visible org-wide, identical to pre-Phase-6 behavior for every
  // existing role — see chat.service.ts's listAgents for how these combine.
  @Prop({ type: [String], default: [] })
  assignedDepartments: string[];

  @Prop({ type: [String], default: [] })
  assignedUserIds: string[];

  // Which of python-agent's registered tools this persona may call — empty
  // means unrestricted (see app.tools.registry.get_tool_definitions and
  // anthropic_client.call's docstring: an empty/falsy list is treated
  // identically to unset, so this is backward compatible for every existing
  // role with no migration needed).
  @Prop({ type: [String], default: [] })
  allowedTools: string[];

  // Unset = today's existing message-length/round-based heuristic
  // (app.agent.router.choose_model), unchanged. See Phase 5 plan notes for
  // why this is a model TIER, not a raw provider choice — Groq cannot make
  // tool calls, so exposing raw provider selection here could silently break
  // a tool-using persona.
  @Prop({ enum: ['fast', 'standard'] })
  modelTier?: 'fast' | 'standard';

  @Prop({ default: '#6b7280' }) avatarColor: string;

  // Audit trail only — no RBAC gating exists in this app yet (see plan notes).
  @Prop({ required: true }) createdBy: string;
}

export const AgentRoleSchema = SchemaFactory.createForClass(AgentRole);
AgentRoleSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
