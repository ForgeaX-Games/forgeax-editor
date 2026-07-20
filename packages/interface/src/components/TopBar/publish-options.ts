// Single source of truth for the Publish dropdown's option metadata.
//
// The same list drives three surfaces so their wording can never drift:
//   1. dropdown item `title` tooltip      → doc.what
//   2. dropdown item subtitle (mi-sub)    → doc.when
//   3. first-run coach-mark onboarding    → doc.what + doc.when + hint
//
// Copy lives in i18n under `topbar.package.doc.<id>.*`; this file only owns the
// structural metadata (order, DOM anchor id, gray/coming-soon flag).

export type PublishOptionKind = 'target' | 'option' | 'tool';

export interface PublishOptionMeta {
  /** Stable id — also the `data-onboard` DOM anchor + i18n doc key. */
  id: string;
  kind: PublishOptionKind;
  /** Coming-soon / disabled (iOS, platform publish) — grayed, skipped by the tour. */
  gray?: boolean;
  /** Coach-mark callout placement relative to the anchored element. */
  place: 'below' | 'left';
}

/** Ordered as they appear in the dropdown. `gray` items render but the tour skips them. */
export const PUBLISH_OPTIONS: PublishOptionMeta[] = [
  { id: 'web', kind: 'target', place: 'left' },
  { id: 'windows', kind: 'target', place: 'left' },
  { id: 'macos', kind: 'target', place: 'left' },
  { id: 'android', kind: 'target', place: 'left' },
  { id: 'ios', kind: 'target', place: 'left' },
  { id: 'cloud', kind: 'target', place: 'left', gray: true },
  { id: 'engine', kind: 'option', place: 'left' },
  { id: 'history', kind: 'tool', place: 'left' },
  { id: 'clean', kind: 'tool', place: 'left' },
];

export interface PublishDoc {
  what: string;
  when: string;
}

type Translate = (key: string, opts?: Record<string, string | number>) => string;

/** Resolve the what/when copy for an option from i18n (falls back to empty). */
export function publishDoc(t: Translate, id: string): PublishDoc {
  return {
    what: t(`topbar.package.doc.${id}.what`),
    when: t(`topbar.package.doc.${id}.when`),
  };
}
