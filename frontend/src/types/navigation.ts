import type { IconType } from 'react-icons';

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: IconType;
  // One-line plain-language explanation of the page, shown in the sidebar's
  // hover card and next to the page title in the TopBar.
  hint?: string;
  badge?: number;
  // Only agent_user ever populates this — admin/legacy user roles always see everything.
  hideForRoles?: string[];
}

// One section of the sidebar's application nav — see constants/navigation.ts.
// `label` is optional in the type (SidebarNav skips rendering a header when
// it's absent), but every current group sets one for a consistent look.
export interface NavGroup {
  id: string;
  label?: string;
  items: NavItem[];
}
