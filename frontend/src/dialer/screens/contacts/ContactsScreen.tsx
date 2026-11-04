import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { callingService, COUNTRIES, type CallableCustomer } from '@/services/callingService';
import { hasRole } from '@/utils/roles';
import { FiAlertTriangle, FiPhone, FiSearch, FiUsers, FiX } from '../../components/icons';
import { ActionButton, StateScreen } from '../../components/StateScreen';
import { useDialerAccess } from '../../lib/access';
import { dialableProblem, entryFromPaste } from '../../lib/dialRules';
import { usePlaceCall } from '../../lib/placeCall';
import styles from './ContactsScreen.module.css';

const SEARCH_DELAY_MS = 300;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/**
 * Customers to call: HaiVE's own customer list (the Customers page), searched by
 * name, company or number. Owners, admins and managers see every customer;
 * everyone else the ones they're the Customer Rep of. A call placed from here is
 * linked to the customer's open deal, so its report gets that context.
 */
export function ContactsScreen() {
  const { user, canPlace } = useDialerAccess();
  const navigate = useNavigate();
  const { place } = usePlaceCall();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [calling, setCalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useQuery({
    queryKey: ['dialer', 'contacts', search],
    queryFn: () => callingService.searchContacts(search),
    enabled: canPlace && search.length >= 2,
    staleTime: 60_000,
  });

  if (!canPlace) {
    return (
      <StateScreen icon={<FiUsers />} title="Contacts are for placing calls">
        <p>Placing calls isn’t part of your access, so there’s no one to call from here. Your calls are in Recents.</p>
      </StateScreen>
    );
  }

  const seesEveryone =
    hasRole(user, 'owner') || hasRole(user, 'admin') || hasRole(user, 'manager') || !!user?.permissions?.includes('customers:view');

  // A number written with its country code is called straight away; one
  // without goes to the keypad first, where its country can be checked.
  const callNumber = async (customer: CallableCustomer, raw: string) => {
    setError(null);
    const entry = entryFromPaste(raw, COUNTRIES[0]);
    const handOff = { number: entry, customerName: customer.name, dealId: customer.deal?.id };
    if (!entry.startsWith('+') || dialableProblem(entry.slice(1))) {
      navigate('/', { state: handOff });
      return;
    }
    setCalling(`${customer.id}|${raw}`);
    const result = await place({ digits: entry.slice(1), customerName: customer.name, dealId: customer.deal?.id });
    setCalling(null);
    if (!result.ok && result.message) setError(result.message);
  };

  const list = results.data ?? [];

  return (
    <div className={styles.screen}>
      <h1 className="sr-only">Contacts</h1>
      <div className={styles.searchBar}>
        <label className={styles.search}>
          <FiSearch />
          <span className="sr-only">Search customers</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, company or number"
            autoComplete="off"
            enterKeyHint="search"
          />
          {query && (
            <button type="button" className={styles.clear} onClick={() => setQuery('')} aria-label="Clear search">
              <FiX />
            </button>
          )}
        </label>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {search.length < 2 ? (
        <StateScreen icon={<FiUsers />} title="Find a customer to call">
          <p>Search your HaiVE customers by name, company or any part of their number.</p>
          {!seesEveryone && <p>You’ll see the customers you’re the Customer Rep of.</p>}
        </StateScreen>
      ) : results.isLoading ? (
        <p className={styles.status} role="status">
          Searching…
        </p>
      ) : results.isError ? (
        <StateScreen
          icon={<FiAlertTriangle />}
          tone="warning"
          title="Couldn’t search right now"
          actions={<ActionButton onClick={() => void results.refetch()}>Try again</ActionButton>}
        />
      ) : list.length === 0 ? (
        <p className={styles.status} role="status">
          No customers match “{search}”.
        </p>
      ) : (
        <>
          <p className="sr-only" role="status">
            {list.length} {list.length === 1 ? 'customer' : 'customers'} found.
          </p>
          <ul className={styles.list}>
            {list.map((customer) => (
              <li key={customer.id} className={styles.customer}>
                <span className={styles.avatar} aria-hidden>
                  {initials(customer.name) || <FiUsers />}
                </span>
                <div className={styles.who}>
                  <span className={styles.name}>{customer.name}</span>
                  {(customer.company || customer.deal?.name) && (
                    <span className={styles.sub}>{[customer.company, customer.deal?.name].filter(Boolean).join(' · ')}</span>
                  )}
                  {customer.phones.length === 0 && <span className={styles.sub}>No number on file</span>}
                  {customer.phones.map((phone) => {
                    const key = `${customer.id}|${phone.number}`;
                    return (
                      <div key={phone.number} className={styles.phone}>
                        <span className={styles.number}>
                          {phone.number}
                          {phone.label && <span className={styles.label}> · {phone.label}</span>}
                        </span>
                        <button
                          type="button"
                          className={styles.call}
                          onClick={() => void callNumber(customer, phone.number)}
                          disabled={calling !== null}
                          aria-busy={calling === key || undefined}
                          aria-label={`Call ${customer.name}${phone.label ? ` (${phone.label})` : ''}, ${phone.number}`}
                        >
                          <FiPhone />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
