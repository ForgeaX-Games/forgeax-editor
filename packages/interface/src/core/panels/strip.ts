// packages/interface/src/core/panels/strip.ts
//
// ADR-0030 §2.2 — StatusItemContribution: the `strip` (status bar) member of
// the ShellContribution family. A status item is a LIGHT footer registration
// (text / button / custom chip) that never enters PanelShell. It shares the
// single contribution channel (host.panels → contributePanels) and the derived
// snapshot with panel (View) contributions; only the shape and target location
// differ.
//
// Why three item sub-types (ADR-0030 §2.2):
//   - text   — static / derived label; serializable → cross-realm-safe.
//   - button — command-driven action; serializable → cross-realm-safe.
//   - custom — escape hatch for live chips that hold their own polling/state
//              (version, resource, health, kind counts). IN-PROCESS ONLY.
import type { ReactNode } from 'react';

/** Strip locations exposed by the footer StripHostView. `center` is the flex
 *  spacer between the left/right chip groups (content is flex-end aligned so a
 *  lone chip pins to the far right — matches the legacy status bar layout). */
export type StripLocationId = 'statusbar.left' | 'statusbar.center' | 'statusbar.right';

export const STRIP_LOCATIONS = ['statusbar.left', 'statusbar.center', 'statusbar.right'] as const;

export type StatusItemBody =
  /** Static / derived text. */
  | { readonly type: 'text'; readonly text: string; readonly tooltip?: string }
  /** Icon/label button; clicking runs `command` through host.commands. */
  | {
      readonly type: 'button';
      readonly label?: string;
      /** lucide icon name (resolved by StripHostView), optional. */
      readonly icon?: string;
      readonly tooltip?: string;
      readonly command: string;
      readonly args?: unknown;
    }
  /** In-process live chip. The render owns its own subscriptions/polling. */
  | { readonly type: 'custom'; readonly render: () => ReactNode };

export interface StatusItemContribution {
  readonly kind?: 'status-item';
  /** Stable id; collisions overwrite (later contribution wins per key). */
  readonly id: string;
  readonly location: StripLocationId;
  /** Higher = more permanent (anchored); lower = rotates in the carousel when
   *  the slot overflows. Default 0. */
  readonly priority?: number;
  /** Conditional visibility. Missing = always visible. */
  readonly when?: () => boolean;
  readonly item: StatusItemBody;
}
