import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { FiPhoneCall, FiPhoneIncoming, FiPhoneOutgoing, FiSettings } from 'react-icons/fi';
import { Button, Input, Skeleton } from '@/components/ui';
import { CallStatus } from '@/features/calling/CallStatus';
import { ROUTES } from '@/constants/routes';
import { plivoService, formatPhone, isCallActive, type PlivoCall, type PlivoLine } from '@/services/plivoService';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import { ROW_IN, staggerChildren } from '../motion';
import { CustomerPicker, type SelectedCustomer } from './CustomerPicker';
import { LinkLineToMe } from './LinkLineToMe';
import styles from './PhoneCallCard.module.css';

const RECENT_LIMIT = 5;

// Why an administrator can't call yet. A call goes out over the Plivo number linked to whoever is signed in, and a
// number belongs to one person at a time — so say who holds it rather than a vague "link a number to yourself".
function adminBlockedMessage(lines: PlivoLine[]): string {
  const active = lines.filter((line) => line.active);
  if (active.length === 0) return 'Almost there — add a Plivo line linked to you to place calls.';
  const owners = [...new Set(active.map((line) => line.userName))].join(', ');
  const numbers = active.map((line) => formatPhone(line.plivoNumber)).join(', ');
  return `${numbers} ${active.length === 1 ? 'is' : 'are'} linked to ${owners}, so only ${
    active.length === 1 ? 'they' : 'those people'
  } can place calls. Link ${active.length === 1 ? 'it' : 'a number'} to yourself to call from your own account.`;
}

function StateBlock({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.state}>
      <span className={styles.stateIcon} aria-hidden>
        <FiPhoneCall />
      </span>
      <div className={styles.stateBody}>
        <div className={styles.stateTitle}>{title}</div>
        {children && <div className={styles.stateText}>{children}</div>}
        {actions}
      </div>
    </div>
  );
}

// Place a real phone call from Call Copilot. Plivo rings the agent's own phone
// first; when they answer it dials the customer, and records the whole
// conversation — which then shows up in Call Library with a transcript, summary
// and AI Coach report, exactly like an uploaded recording.
export function PhoneCallCard({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const [customer, setCustomer] = useState<SelectedCustomer | null>(null);
  const [number, setNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ['plivo', 'config'],
    queryFn: plivoService.getConfig,
    staleTime: 30_000,
  });
  const { data: calls } = useQuery({
    queryKey: ['plivo', 'calls', 'mine'],
    queryFn: () => plivoService.listCalls('mine'),
    enabled: config?.connected === true,
    // Keep watching while a call is live or its recording is being processed.
    refetchInterval: (query) => (query.state.data?.some(isCallActive) ? 6_000 : false),
  });

  if (!config) {
    return (
      <div className={styles.loading} aria-busy>
        <Skeleton height={20} width="40%" />
        <Skeleton height={44} />
        <Skeleton height={44} />
      </div>
    );
  }

  if (!config.connected) {
    return (
      <StateBlock
        title="Phone calls aren't set up yet"
        actions={
          config.canManage ? (
            <div className={styles.stateActions}>
              <Button
                type="button"
                variant="secondary"
                leftIcon={<FiSettings />}
                onClick={() => navigate(ROUTES.settingsCalling)}
              >
                Set up calling
              </Button>
            </div>
          ) : undefined
        }
      >
        {config.canManage
          ? 'Connect Plivo to place and receive calls here. Every call is recorded, then transcribed, summarized and coached automatically.'
          : 'An administrator needs to connect Plivo in Settings → Calling before you can place calls from here.'}
      </StateBlock>
    );
  }

  if (!config.canCall) {
    return (
      <div className={styles.stack}>
        <StateBlock title="Call a customer">
          {config.canManage
            ? adminBlockedMessage(config.lines)
            : 'Calling is set up, but no Plivo number is linked to you yet. Ask an administrator to add one.'}
        </StateBlock>
        {config.canManage && user && config.lines.length > 0 && (
          <LinkLineToMe
            lines={config.lines}
            userId={user.id}
            defaultCountryCode={config.defaultCountryCode}
            onOpenSettings={() => navigate(ROUTES.settingsCalling)}
          />
        )}
        {config.canManage && config.lines.length === 0 && (
          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              leftIcon={<FiSettings />}
              onClick={() => navigate(ROUTES.settingsCalling)}
            >
              Open calling settings
            </Button>
          </div>
        )}
      </div>
    );
  }

  const myLine = config.lines.find((l) => l.userId === user?.id && l.active);

  const handleCall = async () => {
    setCalling(true);
    try {
      await plivoService.startCall(number, customer?.dealId);
      toast.success(
        myLine
          ? `Calling your phone (${formatPhone(myLine.agentPhone)}). Answer it and you'll be connected to the customer.`
          : "Calling your phone. Answer it and you'll be connected to the customer.",
        { duration: 6_000 },
      );
      setNumber('');
      await queryClient.invalidateQueries({ queryKey: ['plivo', 'calls'] });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setCalling(false);
    }
  };

  const handleRetry = async (call: PlivoCall) => {
    setRetrying(call.id);
    try {
      await plivoService.retryImport(call.id);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setRetrying(null);
      await queryClient.invalidateQueries({ queryKey: ['plivo', 'calls'] });
    }
  };

  const recent = (calls ?? []).slice(0, RECENT_LIMIT);

  return (
    <div className={recent.length > 0 ? styles.split : styles.single}>
      <div className={styles.main}>
        <p className={styles.lead}>
          HaiVE rings your phone{myLine ? <strong> ({formatPhone(myLine.agentPhone)})</strong> : ''} first — answer it
          and you&apos;re connected to the customer. The call is recorded, and its summary and AI Coach report appear in
          Call Library once it ends.
        </p>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void handleCall();
          }}
        >
          <Input
            label="Customer's phone number"
            type="tel"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="98765 43210"
            hint={`Include the country code for numbers outside +${config.defaultCountryCode}.`}
            autoComplete="off"
          />
          <CustomerPicker value={customer} onChange={setCustomer} disabled={calling} />
          <div className={styles.actions}>
            <Button
              type="submit"
              size="lg"
              leftIcon={<FiPhoneCall />}
              loading={calling}
              disabled={number.replace(/\D/g, '').length < 8}
            >
              Call customer
            </Button>
          </div>
        </form>
      </div>

      {recent.length > 0 && (
        <div className={styles.recent}>
          <div className={styles.recentTitle}>Recent calls</div>
          <motion.ul className={styles.callList} variants={staggerChildren(0.05)} initial="hidden" animate="show">
            {recent.map((call) => (
              <motion.li key={call.id} className={styles.callItem} variants={ROW_IN}>
                <span className={styles.callAvatar} aria-hidden>
                  {call.direction === 'outbound' ? <FiPhoneOutgoing /> : <FiPhoneIncoming />}
                </span>
                <div className={styles.callBody}>
                  <div className={styles.callMain}>
                    <span className={styles.callTitle}>
                      {call.direction === 'outbound' ? 'Called' : 'Received from'} {formatPhone(call.customerNumber)}
                    </span>
                    <span className={styles.callMeta}>
                      {new Date(call.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </div>
                  <CallStatus
                    call={call}
                    onRetry={(c) => void handleRetry(c)}
                    retrying={retrying === call.id}
                    onOpenLibrary={onOpenLibrary}
                  />
                </div>
              </motion.li>
            ))}
          </motion.ul>
        </div>
      )}
    </div>
  );
}
