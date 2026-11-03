import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiUpload } from 'react-icons/fi';
import { Button, CopyableText, Drawer, Input, Switch } from '@/components/ui';
import { PhoneNumberField } from '@/features/calling/PhoneNumberField';
import { subAccountsService, type CreatedSubAccount, type SubAccountDetails } from '@/services/subAccountsService';
import { extractErrorMessage } from '@/utils/errors';
import { IMAGE_UPLOAD_TYPES, shrinkImage } from '@/utils/shrinkImage';
import { DEVICE_TIMEZONE, TIMEZONE_GROUPS, isKnownTimezone } from '@/utils/timezones';
import { ACCOUNTS_QUERY_KEY } from './useAccounts';
import { AccountLogo } from './subAccountParts';
import styles from './SubAccountDrawer.module.css';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGO_SIZE = 128;

// The usual choices first; any other ISO code is still accepted by the server.
const CURRENCIES = ['INR', 'USD', 'AUD', 'EUR', 'GBP', 'AED', 'SGD', 'CAD', 'NZD', 'ZAR', 'MYR', 'SAR', 'JPY'];

interface FormState {
  name: string;
  ownerName: string;
  businessEmail: string;
  phone: string;
  phoneCountryCode: string;
  timezone: string;
  currency: string;
  address: string;
  website: string;
  city: string;
  state: string;
  postalCode: string;
  logo: string;
  sendInvite: boolean;
}

function emptyForm(): FormState {
  return {
    name: '',
    ownerName: '',
    businessEmail: '',
    phone: '',
    phoneCountryCode: '',
    timezone: DEVICE_TIMEZONE,
    currency: 'INR',
    address: '',
    website: '',
    city: '',
    state: '',
    postalCode: '',
    logo: '',
    sendInvite: true,
  };
}

function formFrom(account: SubAccountDetails): FormState {
  return {
    ...emptyForm(),
    name: account.name,
    businessEmail: account.profile.businessEmail ?? account.owner?.email ?? '',
    phone: account.profile.phone ?? '',
    phoneCountryCode: account.profile.phoneCountryCode ?? '',
    timezone: account.timezone ?? DEVICE_TIMEZONE,
    currency: account.currency ?? 'INR',
    address: account.profile.address ?? '',
    website: account.profile.website ?? '',
    city: account.profile.city ?? '',
    state: account.profile.state ?? '',
    postalCode: account.profile.postalCode ?? '',
    logo: account.profile.logo ?? '',
  };
}

export interface SubAccountDrawerProps {
  open: boolean;
  onClose: () => void;
  // Set to edit this account; absent to create a new one.
  account?: SubAccountDetails | null;
  onSaved?: () => void;
}

export function SubAccountDrawer({ open, onClose, account, onSaved }: SubAccountDrawerProps) {
  const queryClient = useQueryClient();
  const editing = !!account;
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSubAccount | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setForm(account ? formFrom(account) : emptyForm());
    setProblem(null);
    setCreated(null);
  }, [open, account]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const currencies = useMemo(
    () => (CURRENCIES.includes(form.currency) ? CURRENCIES : [form.currency, ...CURRENCIES]),
    [form.currency],
  );

  const missing = (): string | null => {
    if (!form.name.trim()) return 'Enter the sub-account name.';
    if (!editing && !EMAIL_PATTERN.test(form.businessEmail.trim())) return 'Enter a valid business email.';
    if (!form.phone) return 'Enter a phone number with its country.';
    if (!form.timezone) return 'Choose a time zone.';
    if (!form.currency) return 'Choose a currency.';
    return null;
  };

  const pickLogo = async (file?: File) => {
    if (!file) return;
    if (!IMAGE_UPLOAD_TYPES.includes(file.type)) {
      toast.error('Choose a PNG, JPEG or WebP image.');
      return;
    }
    try {
      set('logo', await shrinkImage(file, { size: LOGO_SIZE }));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const submit = async () => {
    const issue = missing();
    if (issue) {
      setProblem(issue);
      return;
    }
    setProblem(null);
    setSaving(true);
    const details = {
      name: form.name.trim(),
      phoneCountryCode: form.phoneCountryCode,
      phone: form.phone,
      timezone: form.timezone,
      currency: form.currency,
      address: form.address.trim(),
      website: form.website.trim(),
      city: form.city.trim(),
      state: form.state.trim(),
      postalCode: form.postalCode.trim(),
      logo: form.logo,
    };
    try {
      if (account) {
        await subAccountsService.update(account.id, details);
        toast.success('Sub-account updated');
        onClose();
      } else {
        const result = await subAccountsService.create({
          ...details,
          businessEmail: form.businessEmail.trim(),
          ownerName: form.ownerName.trim() || undefined,
          sendInvite: form.sendInvite,
        });
        setCreated(result);
      }
      await queryClient.invalidateQueries({ queryKey: ['sub-accounts'] });
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      onSaved?.();
    } catch (err) {
      setProblem(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const initialPhone = account ? `${(account.profile.phoneCountryCode ?? '').replace(/\D/g, '')}${(account.profile.phone ?? '').replace(/\D/g, '')}` : undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={created ? 'Sub-account created' : editing ? 'Edit sub-account' : 'Create sub-account'}
      description={created || editing ? undefined : 'An independent business with its own login, data and subscription.'}
      width={520}
    >
      {created ? (
        <div className={styles.form}>
          <p className={styles.lead}>
            <strong>{created.name}</strong> is ready.{' '}
            {created.invited
              ? `An invitation to set a password has gone to ${created.ownerEmail}.`
              : 'No invitation was sent, so nobody can sign in to it yet. You can send one from its details page.'}
          </p>
          {created.invited && created.activationLink && (
            <div className={styles.field}>
              <span className={styles.label}>Activation link</span>
              <CopyableText value={created.activationLink} />
              <span className={styles.hint}>Works once, for 7 days. Share it yourself if the email doesn’t arrive.</span>
            </div>
          )}
          <p className={styles.note}>
            It needs its own subscription before its team can use HaiVE. Nothing is charged to your Main Account.
          </p>
          <div className={styles.footer}>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) void submit();
          }}
          noValidate
        >
          <div className={styles.logoRow}>
            <AccountLogo name={form.name || '?'} logo={form.logo || undefined} size="lg" />
            <div className={styles.logoActions}>
              <Button type="button" variant="secondary" size="sm" leftIcon={<FiUpload />} onClick={() => fileRef.current?.click()}>
                {form.logo ? 'Change logo' : 'Add logo'}
              </Button>
              {form.logo && (
                <Button type="button" variant="ghost" size="sm" onClick={() => set('logo', '')}>
                  Remove
                </Button>
              )}
              <span className={styles.hint}>Optional. PNG, JPEG or WebP.</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_UPLOAD_TYPES.join(',')}
              hidden
              onChange={(e) => {
                void pickLogo(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>

          <Input label="Sub-account name" value={form.name} maxLength={120} autoFocus onChange={(e) => set('name', e.target.value)} />

          {!editing && (
            <>
              <Input
                label="Business email"
                type="email"
                placeholder="owner@business.com"
                hint="This becomes the owner’s login. It can’t already be in HaiVE."
                value={form.businessEmail}
                onChange={(e) => set('businessEmail', e.target.value)}
              />
              <Input
                label="Owner’s name (optional)"
                placeholder="Uses the business name if left empty"
                maxLength={100}
                value={form.ownerName}
                onChange={(e) => set('ownerName', e.target.value)}
              />
            </>
          )}

          <PhoneNumberField
            label="Phone number"
            initialValue={initialPhone}
            onChange={(digits, country) => {
              const national = digits ? digits.slice(country.dialCode.replace(/\D/g, '').length) : '';
              setForm((current) => ({ ...current, phone: national, phoneCountryCode: `+${country.dialCode.replace(/\D/g, '')}` }));
            }}
          />

          <div className={styles.twoColumns}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="sub-account-timezone">
                Time zone
              </label>
              <select id="sub-account-timezone" className={styles.select} value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {!isKnownTimezone(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
                {TIMEZONE_GROUPS.map(([region, zones]) => (
                  <optgroup key={region} label={region}>
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="sub-account-currency">
                Currency
              </label>
              <select id="sub-account-currency" className={styles.select} value={form.currency} onChange={(e) => set('currency', e.target.value)}>
                {currencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <details className={styles.more} open={editing}>
            <summary>Address and website (optional)</summary>
            <div className={styles.moreFields}>
              <Input label="Business address" maxLength={300} value={form.address} onChange={(e) => set('address', e.target.value)} />
              <Input label="Website" placeholder="www.business.com" maxLength={200} value={form.website} onChange={(e) => set('website', e.target.value)} />
              <div className={styles.twoColumns}>
                <Input label="City" maxLength={100} value={form.city} onChange={(e) => set('city', e.target.value)} />
                <Input label="State" maxLength={100} value={form.state} onChange={(e) => set('state', e.target.value)} />
              </div>
              <Input label="Postal code" maxLength={20} value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} />
            </div>
          </details>

          {!editing && (
            <div className={styles.switchRow}>
              <span>
                <span className={styles.switchLabel}>Email the owner an invitation</span>
                <span className={styles.hint}>A secure link for them to set their own password.</span>
              </span>
              <Switch checked={form.sendInvite} ariaLabel="Email the owner an invitation" onChange={(checked) => set('sendInvite', checked)} />
            </div>
          )}

          {problem && (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          )}

          <div className={styles.footer}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {editing ? 'Save changes' : 'Create sub-account'}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
