export type PlayDirtyChoice = 'last-saved' | 'save-then-play' | 'cancel';

export type PlayDirtyDecision =
  | { readonly action: 'play'; readonly source: 'last-saved' }
  | { readonly action: 'save-then-play'; readonly source: 'terminal-after-save' }
  | { readonly action: 'cancel' };

export function decidePlayDirtyPolicy(input: { readonly dirty: boolean; readonly choice: PlayDirtyChoice }): PlayDirtyDecision {
  if (input.choice === 'cancel') return { action: 'cancel' };
  if (input.choice === 'save-then-play' && input.dirty) return { action: 'save-then-play', source: 'terminal-after-save' };
  return { action: 'play', source: 'last-saved' };
}
