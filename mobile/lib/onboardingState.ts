/**
 * Shared module-level state for the "has finished onboarding" flag.
 *
 * Why this exists: AuthGuard in `_layout.tsx` reads the flag from AsyncStorage
 * once on mount. When the onboarding screen calls AsyncStorage.setItem and
 * navigates back to `/(tabs)/`, AuthGuard's local `onboarded` state is still
 * `false` — and its routing effect fires again, sending the user STRAIGHT
 * BACK to `/onboarding`. Infinite loop.
 *
 * This module bridges that gap without a context provider rerender chain:
 *   • AuthGuard `subscribeOnboardedState(setOnboarded)` once on mount
 *   • Onboarding screen calls `setOnboardedState(true)` when the user finishes
 *
 * Persistence still lives in AsyncStorage so the flag survives app restarts;
 * the module value is just an in-memory cache so updates are synchronous.
 */

export const ONBOARDING_KEY = 'sacari.onboarded.v1';

type Listener = (v: boolean) => void;
const listeners = new Set<Listener>();
let currentValue: boolean | null = null;

/** Subscribe to changes. Returns an unsubscribe function. If the value has
 *  already been seeded (via `setOnboardedState`), the listener is called
 *  immediately with the current value — same pattern as Zustand. */
export function subscribeOnboardedState(fn: Listener): () => void {
  listeners.add(fn);
  if (currentValue !== null) fn(currentValue);
  return () => { listeners.delete(fn); };
}

/** Set + broadcast. Use after AsyncStorage write completes so persistence
 *  and in-memory cache stay in sync. */
export function setOnboardedState(v: boolean): void {
  currentValue = v;
  listeners.forEach((fn) => fn(v));
}
