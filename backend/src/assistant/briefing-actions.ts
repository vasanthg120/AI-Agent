import { businessDayOf, nextDay, startOfBusinessDay } from '../common/business-day';
import { BriefingFacts } from './briefing-facts.service';

// What Haive may offer to do from a briefing — and only does on the person's yes
// (their choice: "suggest, then act on my yes"). The AI names people by the refs
// in the facts (p1, p2… and "me"); what a ref stands for never leaves the server,
// and running an action reads it from the stored briefing, never from the browser.

export type ActionStatus = 'suggested' | 'running' | 'done' | 'dismissed';

/** As stored with the briefing. */
export interface StoredAction {
  id: string;
  type: 'give_task';
  // The button's words: "Give Abishake a task: Reply to the 6 waiting enquiries".
  label: string;
  title: string;
  personRef: string;
  personName: string;
  personId: string;
  businessId: string;
  timeZone: string;
  due: 'today' | 'tomorrow';
  status: ActionStatus;
  result?: string;
  error?: string;
  taskId?: string;
}

/** As the person sees it. */
export interface ActionView {
  id: string;
  type: 'give_task';
  label: string;
  title: string;
  personName: string;
  due: 'today' | 'tomorrow';
  status: ActionStatus;
  result?: string;
  error?: string;
}

export const MAX_ACTIONS = 2;

/** The AI's suggestions, kept only when they name someone this person may give a task to. */
export function cleanActions(raw: unknown, targets: BriefingFacts['actionTargets']): StoredAction[] {
  if (!Array.isArray(raw) || !targets) return [];
  const out: StoredAction[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (out.length >= MAX_ACTIONS) break;
    if (!a || typeof a !== 'object' || (a as { type?: unknown }).type !== 'give_task') continue;
    const { personRef, title: rawTitle, due } = a as { personRef?: unknown; title?: unknown; due?: unknown };
    const target = typeof personRef === 'string' ? targets[personRef] : undefined;
    const title = String(rawTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!target || title.length < 3 || seen.has(`${personRef}|${title.toLowerCase()}`)) continue;
    seen.add(`${personRef}|${title.toLowerCase()}`);
    const self = personRef === 'me';
    out.push({
      id: `a${out.length + 1}`,
      type: 'give_task',
      label: self ? `Add to your tasks: ${title}` : `Give ${target.name} a task: ${title}`,
      title,
      personRef: personRef as string,
      personName: self ? 'you' : target.name,
      personId: target.personId,
      businessId: target.businessId,
      timeZone: target.timeZone,
      due: due === 'tomorrow' ? 'tomorrow' : 'today',
      status: 'suggested',
    });
  }
  return out;
}

export function actionView(a: StoredAction): ActionView {
  return { id: a.id, type: a.type, label: a.label, title: a.title, personName: a.personName, due: a.due, status: a.status, ...(a.result ? { result: a.result } : {}), ...(a.error ? { error: a.error } : {}) };
}

/** Due at the end of that day in the business's own time zone (as the "Give a task" form does in the browser). */
export function dueDateFor(due: 'today' | 'tomorrow', timeZone: string, now: Date): Date {
  const today = businessDayOf(timeZone, now);
  const day = due === 'tomorrow' ? nextDay(today) : today;
  return new Date(startOfBusinessDay(timeZone, nextDay(day)).getTime() - 60_000);
}
