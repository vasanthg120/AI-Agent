import { NavLink } from 'react-router-dom';
import { FiAward, FiClock, FiUsers } from '../components/icons';
import styles from './TabBar.module.css';

// Nine dots: the keypad, as phones draw it.
function KeypadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden>
      {[5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2.2" />))}
    </svg>
  );
}

const TABS = [
  { to: '/', label: 'Keypad', icon: <KeypadIcon />, end: true },
  { to: '/recents', label: 'Recents', icon: <FiClock aria-hidden /> },
  { to: '/contacts', label: 'Contacts', icon: <FiUsers aria-hidden /> },
  { to: '/scores', label: 'Calls & Scores', icon: <FiAward aria-hidden /> },
];

/** The four sections, at the bottom where a thumb reaches them. */
export function TabBar() {
  return (
    <nav className={styles.bar} aria-label="Dialer">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => `${styles.tab} ${isActive ? styles.active : ''}`}>
          <span className={styles.icon}>{tab.icon}</span>
          <span className={styles.label}>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
