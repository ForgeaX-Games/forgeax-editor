import { buildReferenceFor, REFERENCE_LABEL } from '../Composer/referenceRegistry';
import type { PillPayload } from '../Composer/pill';
import { useAppStore } from '../../store';
import { t } from '@/i18n';

export type MenuItem =
  | { kind: 'item'; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }
  | { kind: 'sep' };

const copy = (text: string) => {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch((err) => {
    console.warn('[ContextMenu] clipboard write failed', err);
  });
};

const textOf = (el: Element | null): string => (el?.textContent ?? '').trim();

const isInput = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

function buildInputMenu(input: HTMLInputElement | HTMLTextAreaElement, selection: string): MenuItem[] {
  const hasSel = selection.length > 0;
  return [
    {
      kind: 'item',
      label: t('contextMenu.cut'),
      disabled: !hasSel,
      onClick: () => {
        if (!hasSel) return;
        copy(selection);
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? 0;
        const v = input.value;
        input.value = v.slice(0, start) + v.slice(end);
        input.setSelectionRange(start, start);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
    },
    { kind: 'item', label: t('contextMenu.copy'), disabled: !hasSel, onClick: () => copy(selection) },
    {
      kind: 'item',
      label: t('contextMenu.paste'),
      onClick: async () => {
        try {
          const text = await navigator.clipboard.readText();
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? input.value.length;
          const v = input.value;
          input.value = v.slice(0, start) + text + v.slice(end);
          const caret = start + text.length;
          input.setSelectionRange(caret, caret);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        } catch (err) {
          console.warn('[ContextMenu] paste failed', err);
        }
      },
    },
    { kind: 'sep' },
    {
      kind: 'item',
      label: t('contextMenu.selectAll'),
      onClick: () => {
        input.focus();
        input.setSelectionRange(0, input.value.length);
      },
    },
  ];
}

/** "引用到 Chat" menu item for a concrete pill, or null. */
function referenceItemFor(pill: PillPayload | null): MenuItem | null {
  if (!pill) return null;
  return { kind: 'item', label: REFERENCE_LABEL, onClick: () => useAppStore.getState().requestComposerInsert(pill) };
}

/** Selected-text fallback pill (when the target isn't a registered unit). */
function selectionPill(selection: string): PillPayload | null {
  const s = selection.trim();
  if (!s) return null;
  return {
    kind: 'log',
    display: s.length > 30 ? s.slice(0, 30) + '…' : s,
    icon: '📝',
    detail: `[${t('contextMenu.textReference')}: "${s}"]`,
    tooltip: { title: `📝 ${t('contextMenu.selectedTextReference')}`, lines: [s.slice(0, 100)] },
  };
}

export function buildMenu(target: EventTarget | null, selection: string): MenuItem[] {
  if (!(target instanceof Element)) return [];

  // 1) Native inputs — cut/copy/paste/select-all.
  const inputEl = isInput(target) ? target : (target.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null);
  if (inputEl) {
    const selText =
      typeof inputEl.selectionStart === 'number' && typeof inputEl.selectionEnd === 'number'
        ? inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd)
        : '';
    return buildInputMenu(inputEl, selText || selection);
  }

  // 2) Code blocks — copy only.
  const codeWrap = target.closest('.md-code-wrap, pre.md-code');
  if (codeWrap) {
    const code = textOf(codeWrap.querySelector('code') ?? codeWrap);
    return [{ kind: 'item', label: t('contextMenu.copyCode'), disabled: !code, onClick: () => copy(code) }];
  }
  const inlineCode = target.closest('.md-inline-code');
  if (inlineCode) {
    const code = textOf(inlineCode);
    return [{ kind: 'item', label: t('contextMenu.copy'), disabled: !code, onClick: () => copy(selection || code) }];
  }

  // 3) Game-slug breadcrumb — copy path (not a referenceable unit).
  const slug = target.closest('.fp-slug');
  if (slug) {
    const path = textOf(slug);
    return [{ kind: 'item', label: t('contextMenu.copyPath'), disabled: !path, onClick: () => copy(path) }];
  }

  // 4) Registered referenceable units (the SSOT). One lookup covers files,
  //    dirs, agents, plugins, workspace/game/session rows, chat messages, etc.
  const ref = buildReferenceFor(target);
  // Units with their own dedicated menu (e.g. workspace tabs) opt out of the
  // global menu so the two don't stack and intercept each other's clicks.
  if (ref?.descriptor.ownMenu) return [];
  const refItem = referenceItemFor(ref?.pill ?? selectionPill(selection));
  const copyItems: MenuItem[] = (ref?.descriptor.copy?.(ref.el) ?? []).map((c) => ({
    kind: 'item', label: c.label, onClick: () => copy(c.text),
  }));

  if (ref || copyItems.length > 0) {
    return withReference(refItem, copyItems);
  }

  // 5) Plain selected text — reference + copy.
  if (selection.trim().length > 0) {
    return withReference(refItem, [{ kind: 'item', label: t('contextMenu.copy'), onClick: () => copy(selection) }]);
  }

  // 6) Catch-all: reference alone if we have one.
  return refItem ? [refItem] : [];
}

function withReference(ref: MenuItem | null, items: MenuItem[]): MenuItem[] {
  if (!ref) return items;
  if (items.length === 0) return [ref];
  return [ref, { kind: 'sep' }, ...items];
}
