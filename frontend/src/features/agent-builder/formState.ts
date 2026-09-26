import type { AgentRole, CreateAgentRolePayload, RoleCategory } from '@/services/agentRolesService';
import { normalizeRoleCategory } from '@/services/agentRolesService';

// One flat object for the whole wizard — every step reads/writes into this
// directly, so switching steps (or clicking back to an earlier one) never
// loses data, same model AgentConfigurationForm.tsx used for its tabs.
export interface FormState {
  // Set once a real backend draft exists — either because we're editing an
  // existing role, or because Step 0's Document/Describe method already
  // created one (those two API calls create the Mongo doc immediately, same
  // as today's app). Once set, Review's submit must PATCH this id instead
  // of POSTing a new role.
  id?: string;
  name: string;
  department: RoleCategory;
  description: string;
  systemPrompt: string;
  assignedDepartments: string[];
  assignedUserIds: string[];
  allowedTools: string[];
  modelTier: 'fast' | 'standard' | null;
  status: 'draft' | 'active';
  sourceDocumentName?: string;
}

export function blankFormState(): FormState {
  return {
    name: '',
    department: 'custom',
    description: '',
    systemPrompt: '',
    assignedDepartments: [],
    assignedUserIds: [],
    allowedTools: [],
    modelTier: null,
    status: 'draft',
  };
}

export function roleToFormState(role: AgentRole): FormState {
  return {
    id: role._id,
    name: role.name,
    department: normalizeRoleCategory(role.department),
    description: role.description ?? '',
    systemPrompt: role.systemPrompt ?? '',
    assignedDepartments: role.assignedDepartments ?? [],
    assignedUserIds: role.assignedUserIds ?? [],
    allowedTools: role.allowedTools ?? [],
    modelTier: role.modelTier ?? null,
    status: role.status,
    sourceDocumentName: role.sourceDocumentName,
  };
}

// A role freshly returned by generate()/generateFromDescription() — same
// shape, applied on top of a blank form when the user picks an AI-assisted
// starting method in Step 0.
export function applyGeneratedRole(role: AgentRole): FormState {
  return roleToFormState(role);
}

export function formStateToPayload(form: FormState): CreateAgentRolePayload {
  return {
    name: form.name,
    department: form.department,
    description: form.description,
    systemPrompt: form.systemPrompt,
    assignedDepartments: form.assignedDepartments,
    assignedUserIds: form.assignedUserIds,
    allowedTools: form.allowedTools,
    modelTier: form.modelTier,
  };
}
