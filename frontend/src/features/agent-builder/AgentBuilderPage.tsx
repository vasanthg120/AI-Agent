import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Button, Stepper } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { ROUTES } from '@/constants/routes';
import { agentRolesService } from '@/services/agentRolesService';
import { usersService, type AdminUser } from '@/services/usersService';
import { blankFormState, formStateToPayload, roleToFormState, type FormState } from './formState';
import { StepStart } from './steps/StepStart';
import { StepBasics } from './steps/StepBasics';
import { StepInstructions } from './steps/StepInstructions';
import { StepKnowledge } from './steps/StepKnowledge';
import { StepAccess } from './steps/StepAccess';
import { StepTools } from './steps/StepTools';
import { StepMemory } from './steps/StepMemory';
import { StepSecurity } from './steps/StepSecurity';
import { StepReview } from './steps/StepReview';
import styles from './AgentBuilderPage.module.css';

const CREATE_STEPS = [
  { id: 'start', label: 'Start' },
  { id: 'basics', label: 'Basics' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'access', label: 'Access' },
  { id: 'tools', label: 'Tools' },
  { id: 'memory', label: 'Memory' },
  { id: 'security', label: 'Security' },
  { id: 'review', label: 'Review' },
];

// Ground-up redesign of the old modal-based CreateAgentDialog +
// AgentConfigurationForm (both deleted) — a dedicated full page instead of a
// 720px modal, since a 9-section wizard needs the room. Create and Edit
// share this one component: Edit skips the Step 0 "Start from" screen
// (nothing to generate — the role already exists) and starts on Basics.
export function AgentBuilderPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const steps = isEdit ? CREATE_STEPS.filter((s) => s.id !== 'start') : CREATE_STEPS;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState<'draft' | 'active' | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [form, setForm] = useState<FormState>(blankFormState());
  const [stepIndex, setStepIndex] = useState(0);
  const [visited, setVisited] = useState<string[]>([]);

  const currentStep = steps[stepIndex];

  useEffect(() => {
    // Best-effort — GET /users is admin-only, but a 403 here must not break
    // the page for a non-admin viewer, only leave the "Visible to specific
    // people" picker empty (same precedent as the old AgentRolesSettings.tsx).
    void usersService
      .list()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    if (!isEdit || !id) return;
    setLoading(true);
    // No GET /agent-roles/:id route exists (only list/generate/create/update/
    // delete) — finding it in the full list is the same approach the old
    // list page's own state already relied on, just re-fetched here since
    // this is now a separate route rather than a modal fed by that page's
    // in-memory state.
    agentRolesService
      .list()
      .then((roles) => {
        const role = roles.find((r) => r._id === id);
        if (!role || role.builtin) {
          toast.error('Agent not found');
          navigate(ROUTES.settingsAgentRoles);
          return;
        }
        setForm(roleToFormState(role));
      })
      .catch((err) => toast.error(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [isEdit, id, navigate]);

  const update = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const markVisited = (stepId: string) => setVisited((prev) => (prev.includes(stepId) ? prev : [...prev, stepId]));

  const goNext = () => {
    if (currentStep.id === 'basics' && !form.name.trim()) {
      toast.error('Give your agent a name first.');
      return;
    }
    if (currentStep.id === 'instructions' && !form.systemPrompt.trim()) {
      toast.error('Add instructions before continuing.');
      return;
    }
    markVisited(currentStep.id);
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  const handleStartComplete = (patch: Partial<FormState>) => {
    update(patch);
    markVisited('start');
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };

  const isAlreadyActive = isEdit && form.status === 'active';

  const handleSave = async (targetStatus: 'draft' | 'active') => {
    if (!form.name.trim() || !form.systemPrompt.trim()) {
      toast.error('Name and Instructions are required.');
      return;
    }
    setSaving(targetStatus);
    try {
      let savedId = form.id;
      const payload = formStateToPayload(form);
      if (!savedId) {
        const created = await agentRolesService.create(payload);
        savedId = created._id;
      } else {
        await agentRolesService.update(savedId, payload);
      }
      // Only send a separate activation call when actually transitioning —
      // re-saving an already-active role never re-sends status, matching
      // the old app's exact behavior (avoids a redundant publish-source
      // call on every edit of a live role).
      const activating = targetStatus === 'active' && form.status !== 'active';
      if (savedId && activating) {
        await agentRolesService.update(savedId, { status: 'active' });
      }
      toast.success(targetStatus === 'active' ? 'Agent activated' : 'Draft saved');
      navigate(ROUTES.settingsAgentRoles);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return <div className={styles.page}>Loading…</div>;
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{isEdit ? `Edit ${form.name || 'Agent'}` : 'Create AI Agent'}</h1>
        <Button type="button" variant="ghost" onClick={() => navigate(ROUTES.settingsAgentRoles)}>
          Cancel
        </Button>
      </div>

      <Stepper steps={steps} currentId={currentStep.id} completedIds={visited} />

      <div className={styles.content}>
        {currentStep.id === 'start' && <StepStart onComplete={handleStartComplete} />}
        {currentStep.id === 'basics' && <StepBasics form={form} update={update} />}
        {currentStep.id === 'instructions' && <StepInstructions form={form} update={update} />}
        {currentStep.id === 'knowledge' && <StepKnowledge form={form} />}
        {currentStep.id === 'access' && <StepAccess form={form} update={update} users={users} />}
        {currentStep.id === 'tools' && <StepTools form={form} update={update} />}
        {currentStep.id === 'memory' && <StepMemory form={form} update={update} />}
        {currentStep.id === 'security' && <StepSecurity form={form} />}
        {currentStep.id === 'review' && <StepReview form={form} users={users} />}
      </div>

      {currentStep.id !== 'start' && (
        <div className={styles.footer}>
          <Button type="button" variant="ghost" onClick={goBack} disabled={stepIndex === 0}>
            Back
          </Button>
          {currentStep.id === 'review' ? (
            isAlreadyActive ? (
              <Button type="button" loading={saving === 'active'} onClick={() => void handleSave('active')}>
                Save Changes
              </Button>
            ) : (
              <div className={styles.footerActions}>
                <Button type="button" variant="outline" loading={saving === 'draft'} onClick={() => void handleSave('draft')}>
                  Save as Draft
                </Button>
                <Button type="button" loading={saving === 'active'} onClick={() => void handleSave('active')}>
                  {isEdit ? 'Save & Activate' : 'Create & Activate'}
                </Button>
              </div>
            )
          ) : (
            <Button type="button" onClick={goNext}>
              Next
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
