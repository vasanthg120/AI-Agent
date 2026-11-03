import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { FiArrowLeft, FiArrowRight, FiCheckCircle, FiCpu, FiLock, FiMail, FiKey, FiShield, FiUserPlus } from 'react-icons/fi';
import { Badge, Button, CopyableText, Drawer, EmptyState, Input, Stepper, Switch, Tabs } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import {
  usersService,
  type AdminUser,
  type AssignableAiRole,
  type CreateUserResult,
  type PermissionCatalog,
  type UpdateUserPayload,
} from '@/services/usersService';
import type { User } from '@/types';
import { can } from '@/utils/access';
import { extractErrorMessage } from '@/utils/errors';
import { hasRole } from '@/utils/roles';
import { ADMINISTRATOR, AiRolePicker } from './AiRolePicker';
import { PermissionGrid } from './PermissionGrid';
import { ACTION_LABEL, normalize, pageLabels, summaryText } from './permissionModel';
import styles from './UserDrawer.module.css';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// short: the stepper's label, kept to a word or two so none is cut off; label: the step's heading.
const STEPS = [
  { id: 'basics', short: 'Basics', label: 'Basic information' },
  { id: 'role', short: 'AI role', label: 'AI role & agent' },
  { id: 'access', short: 'Access', label: 'Access & permissions' },
  { id: 'review', short: 'Review', label: 'Review & create' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const EDIT_TABS = [
  { id: 'details', label: 'Details' },
  { id: 'role', label: 'AI role' },
  { id: 'access', label: 'Access' },
];

const OLDER_TYPE_LABEL: Record<string, string> = { manager: 'Manager', consultant: 'Consultant', user: 'Standard user' };

interface Form {
  name: string;
  email: string;
  sendInvite: boolean;
  active: boolean;
  department: string;
  aiAccessEnabled: boolean;
  voiceAccessEnabled: boolean;
  /** An AI role's slug, ADMINISTRATOR, or '' — not chosen yet (or, editing, an older account type kept as it is). */
  role: string;
  permissions: string[];
  /** Editing an older AI-role account: true once it's moved onto its own permission list. */
  ownList: boolean;
}

function blankForm(): Form {
  return {
    name: '',
    email: '',
    sendInvite: false,
    active: true,
    department: '',
    aiAccessEnabled: true,
    voiceAccessEnabled: true,
    role: '',
    permissions: [],
    ownList: true,
  };
}

function formFor(user: AdminUser): Form {
  const isAdmin = user.roles.includes('admin') || user.roles.includes('owner');
  const isTeamMember = user.roles.includes('agent_user');
  return {
    ...blankForm(),
    name: user.name,
    email: user.email,
    active: user.active,
    department: user.department ?? '',
    aiAccessEnabled: user.aiAccessEnabled !== false,
    voiceAccessEnabled: user.voiceAccessEnabled !== false,
    role: isAdmin ? ADMINISTRATOR : isTeamMember ? (user.assignedAgentId ?? '') : '',
    permissions: user.accessMode === 'permissions' ? (user.permissions ?? []) : (user.olderPermissions ?? []),
    ownList: user.accessMode === 'permissions',
  };
}

export interface UserDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Present when editing someone. */
  user?: AdminUser | null;
  catalog: PermissionCatalog;
  aiRoles: AssignableAiRole[];
  /** The signed-in person: what they may give away. */
  me: User | null;
  onSaved: () => void;
}

/**
 * Adding a person in four steps — who they are, which AI role (and so which AI
 * agent and account type) they get, exactly which pages and actions they can use,
 * then a review — and editing anyone the same way. Owners and admins can give
 * anything; someone else with User Management only what they have themselves
 * (the server holds both to it).
 */
export function UserDrawer({ open, onClose, user, catalog, aiRoles, me, onSaved }: UserDrawerProps) {
  const navigate = useNavigate();
  const editing = !!user;
  const fullAdmin = hasRole(me, 'owner') || hasRole(me, 'admin');
  const grantable = fullAdmin ? null : (me?.permissions ?? []);
  const isOwnerTarget = !!user?.roles.includes('owner');
  const isSelf = !!user && user.id === me?.id;
  const accessLocked = isOwnerTarget || isSelf;

  const [form, setForm] = useState<Form>(blankForm);
  const [step, setStep] = useState<StepId>('basics');
  const [reached, setReached] = useState<StepId[]>([]);
  const [tab, setTab] = useState('details');
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreateUserResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(user ? formFor(user) : blankForm());
    setStep('basics');
    setReached([]);
    setTab('details');
    setCreated(null);
  }, [open, user]);

  const set = (patch: Partial<Form>) => setForm((prev) => ({ ...prev, ...patch }));
  const chosenRole = aiRoles.find((r) => r.slug === form.role);
  // Their AI role may be one that can't be chosen any more (draft or gone).
  const currentRoleUnavailable = editing && user?.roles.includes('agent_user') && form.role === user.assignedAgentId && !chosenRole;
  const defaults = chosenRole ? normalize(chosenRole.defaultPermissions, catalog) : undefined;
  const isAdministrator = form.role === ADMINISTRATOR;
  const olderType = editing && !form.role && user ? OLDER_TYPE_LABEL[user.roles[0]] : undefined;

  const chooseRole = (slug: string) => {
    if (slug === ADMINISTRATOR) return set({ role: slug });
    const role = aiRoles.find((r) => r.slug === slug);
    const startFrom = role ? normalize(role.defaultPermissions, catalog).filter((k) => !grantable || grantable.includes(k)) : [];
    // A new person starts from the role's defaults, and so does someone moving from
    // Administrator or an older account type. Anyone else keeps their access as it is
    // (an older team member keeps following their new role's features) — nothing
    // changes behind the admin's back.
    if (!editing || form.role === ADMINISTRATOR || !form.role) {
      return set({ role: slug, permissions: startFrom, ownList: true });
    }
    set({ role: slug });
  };

  const problems: Record<StepId, string | null> = {
    basics: !form.name.trim()
      ? 'Enter the person’s name.'
      : !editing && !EMAIL_PATTERN.test(form.email.trim())
        ? 'Enter a valid email address.'
        : null,
    role: !form.role ? 'Choose an AI role for this person.' : null,
    access: null,
    review: null,
  };
  const firstProblem = STEPS.map((s) => problems[s.id]).find(Boolean) ?? null;
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  const goTo = (next: StepId) => {
    setReached((prev) => (prev.includes(step) ? prev : [...prev, step]));
    setStep(next);
  };

  const create = async () => {
    setSaving(true);
    try {
      const result = await usersService.create({
        email: form.email.trim(),
        name: form.name.trim(),
        sendInvite: form.sendInvite || undefined,
        active: form.active,
        department: form.department.trim() || undefined,
        aiAccessEnabled: form.aiAccessEnabled,
        voiceAccessEnabled: form.voiceAccessEnabled,
        ...(isAdministrator ? { role: 'admin' as const } : { role: 'agent_user' as const, assignedAgentId: form.role, permissions: form.permissions }),
      });
      setCreated(result);
      toast.success(`${result.user.name} was created`);
      onSaved();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!user) return;
    const patch: UpdateUserPayload = {
      name: form.name.trim(),
      department: form.department.trim(),
      aiAccessEnabled: form.aiAccessEnabled,
      voiceAccessEnabled: form.voiceAccessEnabled,
    };
    if (!accessLocked) {
      if (form.active !== user.active) patch.active = form.active;
      if (isAdministrator) {
        if (!user.roles.includes('admin')) patch.role = 'admin';
      } else if (form.role) {
        if (!user.roles.includes('agent_user') || form.role !== user.assignedAgentId) {
          patch.role = 'agent_user';
          patch.assignedAgentId = form.role;
        }
        if (form.ownList) patch.permissions = form.permissions;
      }
    }
    setSaving(true);
    try {
      await usersService.update(user.id, patch);
      toast.success('Changes saved');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setSaving(false);
    }
  };

  // ---- pieces shared by the wizard and the editor --------------------------------

  const basicsFields = (
    <div className={styles.fields}>
      <Input
        label="Full name"
        placeholder="e.g. Priya Raman"
        autoFocus={!editing}
        maxLength={100}
        value={form.name}
        onChange={(e) => set({ name: e.target.value })}
      />
      {editing ? (
        <Input label="Email address" value={form.email} disabled hint="Their sign-in address. It can’t be changed here." />
      ) : (
        <Input
          label="Email address"
          type="email"
          placeholder="name@company.com"
          hint="They sign in with this address."
          error={form.email.trim() && !EMAIL_PATTERN.test(form.email.trim()) ? 'That email address doesn’t look right.' : undefined}
          value={form.email}
          onChange={(e) => set({ email: e.target.value })}
        />
      )}
      {!editing && (
        <div className={styles.field}>
          <span className={styles.label}>How they get in</span>
          <div className={styles.segment} role="radiogroup" aria-label="How they get in">
            <button type="button" role="radio" aria-checked={!form.sendInvite} className={!form.sendInvite ? styles.segmentOn : styles.segmentItem} onClick={() => set({ sendInvite: false })}>
              <FiKey aria-hidden />
              <span>
                <strong>Temporary password</strong>
                <small>Shown once, for you to pass on.</small>
              </span>
            </button>
            <button type="button" role="radio" aria-checked={form.sendInvite} className={form.sendInvite ? styles.segmentOn : styles.segmentItem} onClick={() => set({ sendInvite: true })}>
              <FiMail aria-hidden />
              <span>
                <strong>Email invitation</strong>
                <small>They choose their own password.</small>
              </span>
            </button>
          </div>
        </div>
      )}
      <div className={styles.switchRow}>
        <span>
          <span className={styles.label}>Account status</span>
          <span className={styles.hint}>
            {accessLocked && editing
              ? isSelf
                ? 'You can’t switch off your own account.'
                : 'The owner’s account is always on.'
              : form.active
                ? 'Active — they can sign in.'
                : 'Deactivated — the account exists but can’t sign in.'}
          </span>
        </span>
        <Switch checked={form.active} disabled={editing && accessLocked} ariaLabel="Account active" onChange={(active) => set({ active })} />
      </div>
      <details className={styles.more}>
        <summary>More options</summary>
        <div className={styles.moreFields}>
          <Input label="Department (optional)" placeholder="e.g. Sales" value={form.department} onChange={(e) => set({ department: e.target.value })} />
          <div className={styles.switchRow}>
            <span>
              <span className={styles.label}>AI access</span>
              <span className={styles.hint}>Off blocks every AI request from this account (chat, analysis) on the business’s credits.</span>
            </span>
            <Switch checked={form.aiAccessEnabled} ariaLabel="AI access" onChange={(aiAccessEnabled) => set({ aiAccessEnabled })} />
          </div>
          <div className={styles.switchRow}>
            <span>
              <span className={styles.label}>Voice AI access</span>
              <span className={styles.hint}>Speech-to-text and text-to-speech only.</span>
            </span>
            <Switch checked={form.voiceAccessEnabled} ariaLabel="Voice AI access" onChange={(voiceAccessEnabled) => set({ voiceAccessEnabled })} />
          </div>
        </div>
      </details>
    </div>
  );

  const roleStep =
    accessLocked && editing ? (
      <p className={styles.note}>
        <FiLock aria-hidden /> {isSelf ? 'You can’t change your own AI role or access. Ask another admin.' : 'The owner always has full access.'}
      </p>
    ) : aiRoles.length === 0 && !fullAdmin ? (
      <EmptyState icon={FiCpu} title="No AI roles to choose from" description="Ask an admin to create and activate an AI role first." />
    ) : (
      <div className={styles.fields}>
        {aiRoles.length === 0 && (
          <div className={styles.note}>
            There are no active AI roles yet. Create one and activate it, then come back to give it to people.{' '}
            {can(me, 'ai_roles') && (
              <Button type="button" variant="secondary" size="sm" onClick={() => navigate(ROUTES.settingsAgentRoles)}>
                Go to AI Roles
              </Button>
            )}
          </div>
        )}
        {olderType && (
          <p className={styles.note}>
            Their account type is <strong>{olderType}</strong>, from before AI roles. It keeps working as it is; choose an AI role to
            move them onto one.
          </p>
        )}
        {currentRoleUnavailable && (
          <p className={styles.warning}>
            Their AI role isn’t available any more (deleted or set back to draft), so they can’t chat with an agent. Choose a new one.
          </p>
        )}
        <AiRolePicker roles={aiRoles} value={form.role} onChange={chooseRole} allowAdministrator={fullAdmin} catalog={catalog} />
      </div>
    );

  const accessStep = isAdministrator ? (
    <div className={styles.fullAccess}>
      <FiShield aria-hidden />
      <span>
        <strong>Full access</strong>
        <span>Administrators can open every page and do everything, with every AI agent. Only the owner’s account is out of their reach.</span>
      </span>
    </div>
  ) : editing && accessLocked ? (
    <>
      <p className={styles.note}>
        <FiLock aria-hidden /> {isSelf ? 'You can’t change your own access. Ask another admin.' : 'The owner always has full access.'}
      </p>
      {isSelf && user?.accessMode === 'permissions' && <PermissionGrid catalog={catalog} value={form.permissions} readOnly />}
    </>
  ) : !form.role ? (
    <p className={styles.note}>
      {olderType
        ? `Their access is decided by their ${olderType} account type, as before. Choose an AI role (on the AI role tab) to set it page by page.`
        : 'Choose an AI role first: it decides where their access starts.'}
    </p>
  ) : !form.ownList ? (
    <div className={styles.fields}>
      <div className={styles.note}>
        <span>
          This person uses the older setup: their access follows the features of their AI role. Below is what that gives them today.
        </span>
        <Button type="button" size="sm" onClick={() => set({ ownList: true })}>
          Set access page by page
        </Button>
      </div>
      <PermissionGrid catalog={catalog} value={form.permissions} readOnly />
    </div>
  ) : (
    <div className={styles.fields}>
      {editing && chosenRole && user?.assignedAgentId !== form.role && (
        <p className={styles.hint}>Their access stays as it is. Use “Reset to AI role defaults” to start from {chosenRole.name}’s.</p>
      )}
      <PermissionGrid
        catalog={catalog}
        value={form.permissions}
        onChange={(permissions) => set({ permissions })}
        grantable={grantable}
        defaults={defaults}
        defaultsLabel="Reset to AI role defaults"
      />
    </div>
  );

  const review = (
    <div className={styles.review}>
      <section className={styles.reviewCard}>
        <h3>Person</h3>
        <dl>
          <div>
            <dt>Name</dt>
            <dd>{form.name.trim()}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{form.email.trim()}</dd>
          </div>
          <div>
            <dt>Sign-in</dt>
            <dd>{form.sendInvite ? 'Email invitation' : 'Temporary password'}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{form.active ? 'Active' : 'Deactivated'}</dd>
          </div>
        </dl>
      </section>
      <section className={styles.reviewCard}>
        <h3>AI role & agent</h3>
        <dl>
          <div>
            <dt>AI role</dt>
            <dd>{isAdministrator ? 'Administrator (every agent)' : chosenRole?.name}</dd>
          </div>
          <div>
            <dt>Account type</dt>
            <dd>
              <Badge variant={isAdministrator ? 'info' : 'accent'}>{isAdministrator ? 'Administrator' : chosenRole?.accountType}</Badge>
            </dd>
          </div>
          {chosenRole?.description && (
            <div>
              <dt>Agent</dt>
              <dd>{chosenRole.description}</dd>
            </div>
          )}
        </dl>
      </section>
      <section className={styles.reviewCard}>
        <h3>Access</h3>
        {isAdministrator ? (
          <p className={styles.muted}>Full access to every page and action.</p>
        ) : (
          <>
            <p className={styles.reviewSummary}>{summaryText(form.permissions)}</p>
            <ul className={styles.reviewModules}>
              {catalog.modules
                .filter((m) => form.permissions.includes(`${m.id}:view`))
                .map((m) => (
                  <li key={m.id}>
                    <span>{m.label}</span>
                    <span className={styles.reviewActions}>
                      {m.actions
                        .filter((a) => form.permissions.includes(`${m.id}:${a}`))
                        .map((a) => ACTION_LABEL[a])
                        .join(' · ')}
                    </span>
                  </li>
                ))}
            </ul>
            {form.permissions.length === 0 && <p className={styles.muted}>Only the basics: {catalog.alwaysIncluded.join(', ')}.</p>}
          </>
        )}
      </section>
    </div>
  );

  // ---- what the drawer shows ------------------------------------------------------

  if (created) {
    return (
      <Drawer open={open} onClose={onClose} title="User created" width={600}>
        <div className={styles.fields}>
          <div className={styles.success}>
            <FiCheckCircle aria-hidden />
            <span>
              <strong>{created.user.name}</strong> is ready
              {isAdministrator ? ' as an Administrator.' : chosenRole ? ` as ${chosenRole.accountType}, working with ${chosenRole.name}.` : '.'}
            </span>
          </div>
          {created.tempPassword ? (
            <>
              <p className={styles.muted}>
                They sign in at <strong>{window.location.origin}</strong> with:
              </p>
              <div className={styles.field}>
                <span className={styles.label}>Email</span>
                <CopyableText value={created.user.email} />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Temporary password</span>
                <CopyableText value={created.tempPassword} />
              </div>
              <p className={styles.warning}>This password won’t be shown again after you close this.</p>
            </>
          ) : (
            <>
              <p className={styles.muted}>An invitation to set their own password has gone to {created.user.email}.</p>
              {created.activationLink && (
                <div className={styles.field}>
                  <span className={styles.label}>Activation link</span>
                  <CopyableText value={created.activationLink} />
                </div>
              )}
            </>
          )}
          <div className={styles.footer}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setForm(blankForm());
                setCreated(null);
                setStep('basics');
                setReached([]);
              }}
            >
              Add another
            </Button>
            <Button type="button" onClick={onClose}>
              {created.tempPassword ? 'Done, I’ve copied it' : 'Done'}
            </Button>
          </div>
        </div>
      </Drawer>
    );
  }

  if (editing && user) {
    return (
      <Drawer
        open={open}
        onClose={() => (saving ? undefined : onClose())}
        title={`Edit ${user.name}`}
        description={user.email}
        width={600}
        scrollKey={tab}
        header={
          <div className={styles.editHead}>
            <Badge variant={user.roles.includes('owner') ? 'warning' : user.roles.includes('admin') ? 'info' : 'accent'}>{user.accountType ?? 'Account'}</Badge>
            {user.needsAiRole && <Badge variant="warning">Needs a new AI role</Badge>}
            {!user.active && <Badge variant="danger">Deactivated</Badge>}
          </div>
        }
        tabs={<Tabs items={EDIT_TABS} activeId={tab} onChange={setTab} />}
      >
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (!problems.basics && !saving) void save();
          }}
        >
          {tab === 'details' && basicsFields}
          {tab === 'role' && roleStep}
          {tab === 'access' && accessStep}
          {problems.basics && <p className={styles.problem}>{problems.basics}</p>}
          <div className={styles.footer}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!!problems.basics}>
              Save changes
            </Button>
          </div>
        </form>
      </Drawer>
    );
  }

  return (
    <Drawer
      open={open}
      onClose={() => (saving ? undefined : onClose())}
      title="Create user"
      description="Give a person their own sign-in, an AI role to work with, and exactly the access they need."
      width={600}
      scrollKey={step}
      header={
        <Stepper
          steps={STEPS.map((s) => ({ id: s.id, label: s.short }))}
          currentId={step}
          completedIds={reached.filter((id) => !problems[id])}
          onStepClick={(id) => {
            const target = STEPS.findIndex((s) => s.id === id);
            // Back to anything; forward only as far as the steps before it are complete.
            if (target <= stepIndex || STEPS.slice(0, target).every((s) => !problems[s.id])) goTo(id as StepId);
          }}
        />
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (step !== 'review') {
            if (!problems[step]) goTo(STEPS[stepIndex + 1].id);
          } else if (!firstProblem && !saving) void create();
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.16, ease: [0.2, 0.9, 0.3, 1] }}
          >
            <h3 className={styles.stepTitle}>{STEPS[stepIndex].label}</h3>
            {step === 'basics' && basicsFields}
            {step === 'role' && roleStep}
            {step === 'access' && accessStep}
            {step === 'review' && review}
          </motion.div>
        </AnimatePresence>
        {problems[step] && (form.name || form.email || step !== 'basics') && <p className={styles.problem}>{problems[step]}</p>}
        <div className={styles.footer}>
          {stepIndex > 0 ? (
            <Button type="button" variant="ghost" leftIcon={<FiArrowLeft />} onClick={() => goTo(STEPS[stepIndex - 1].id)} disabled={saving}>
              Back
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          {step === 'review' ? (
            <Button type="submit" leftIcon={<FiUserPlus />} loading={saving} disabled={!!firstProblem}>
              Create user
            </Button>
          ) : (
            <Button type="submit" rightIcon={<FiArrowRight />} disabled={!!problems[step]}>
              {step === 'access' ? 'Review' : 'Continue'}
            </Button>
          )}
        </div>
      </form>
    </Drawer>
  );
}

/** "8 pages" / "Full access" / "Older setup" — a person's access in a few words. */
export function accessSummary(user: AdminUser, catalog?: PermissionCatalog): string {
  if (user.accessMode === 'full') return 'Full access';
  if (user.accessMode === 'permissions') return summaryText(user.permissions ?? []);
  if (user.roles.includes('agent_user') && catalog) {
    const pages = pageLabels(user.olderPermissions ?? [], catalog).length;
    return `${pages} ${pages === 1 ? 'page' : 'pages'} · older setup`;
  }
  return OLDER_TYPE_LABEL[user.roles[0]] ? `${OLDER_TYPE_LABEL[user.roles[0]]} access` : 'Older setup';
}
