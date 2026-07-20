// Onboarding state machine (design §11). Closed union — every phase is
// enumerated so the controller can never be in an "other" state. The RUNTIME
// state (which sub-modal is open, connectivity-check result, countdown) is
// ephemeral React state; only the PERSISTED slice below survives reloads.

import { useEffect, useState } from 'react';
import { APP_EVENTS, STORAGE_KEYS } from '../../lib/storageKeys';

/** Ordered top-level phases. `done` = onboarding fully dismissed/completed. */
export type OnboardingPhase = 'welcome' | 'project' | 'home' | 'done';

export const PHASE_ORDER: readonly OnboardingPhase[] = ['welcome', 'project', 'home'];

/** The slice we persist to localStorage[STORAGE_KEYS.onboarding]. Kept minimal:
 *  it records progress + the completed milestones so a returning user resumes
 *  where they left off (and never re-sees a completed step). */
export interface OnboardingPersisted {
  /** schema version — bump when this shape changes incompatibly. */
  v: 2;
  /** furthest phase reached (resume point). */
  phase: OnboardingPhase;
  /** per-milestone completion, for the side "state machine" affordance + resume. */
  done: {
    tour: boolean;
    firstChat: boolean;
  };
}

const DEFAULT_STATE: OnboardingPersisted = {
  v: 2,
  phase: 'welcome',
  done: { tour: false, firstChat: false },
};

/**
 * Load persisted onboarding state, migrating the legacy boolean "seen" flag:
 * users who already dismissed the old FirstRunSetup must NOT be shown the new
 * wizard — treat them as fully done.
 */
export function loadOnboarding(): OnboardingPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.onboarding);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<OnboardingPersisted>;
      if (parsed && parsed.v === 2 && parsed.phase) {
        return {
          v: 2,
          phase: parsed.phase,
          done: { tour: !!parsed.done?.tour, firstChat: !!parsed.done?.firstChat },
        };
      }
    }
    // Legacy migration: old boolean flag means "already onboarded" → done.
    if (localStorage.getItem(STORAGE_KEYS.onboardingSeenLegacy)) {
      const migrated: OnboardingPersisted = { v: 2, phase: 'done', done: { tour: true, firstChat: true } };
      saveOnboarding(migrated);
      return migrated;
    }
  } catch { /* corrupt / unavailable storage — fall through to defaults */ }
  return { ...DEFAULT_STATE, done: { ...DEFAULT_STATE.done } };
}

export function saveOnboarding(state: OnboardingPersisted): void {
  try {
    localStorage.setItem(STORAGE_KEYS.onboarding, JSON.stringify(state));
    // Keep the legacy flag set once done so any code still reading it (or a
    // downgrade) treats the user as onboarded.
    if (state.phase === 'done') localStorage.setItem(STORAGE_KEYS.onboardingSeenLegacy, '1');
  } catch { /* ignore */ }
}

/**
 * Live onboarding phase for the shell gate (§14 three-state boot): App renders
 * ONLY the onboarding during welcome/project (init state, no shell), then the
 * full shell at home/done. Re-reads on APP_EVENTS.onboardingChanged (dispatched
 * by the controller on every phase change) + cross-tab `storage`.
 */
export function useOnboardingPhase(): OnboardingPhase {
  const [phase, setPhase] = useState<OnboardingPhase>(() => loadOnboarding().phase);
  useEffect(() => {
    const sync = () => setPhase(loadOnboarding().phase);
    window.addEventListener(APP_EVENTS.onboardingChanged, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(APP_EVENTS.onboardingChanged, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return phase;
}
