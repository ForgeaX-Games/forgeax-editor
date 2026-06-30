// Pill data model + sentinel encoding for the rich composer.
//
// A "pill" is a structured reference token in the composer / chat history that:
//   - Displays as a compact chip ("📄 main.ts")
//   - Hovers to a detail tooltip (full path, kind, hints)
//   - On send, expands to a verbose text snippet the AI can act on
//
// The token is encoded into the otherwise-plaintext message string as:
//
//   ⟦pill:<base64url JSON payload>⟧
//
// `⟦` U+27E6 and `⟧` U+27E7 are extremely rare in normal user text, so this is
// effectively a private band the rest of the pipeline can pass through.

export type PillKind = 'file' | 'dir' | 'agent' | 'tool' | 'game' | 'log' | 'entity';

export interface PillPayload {
  kind: PillKind;
  display: string;
  icon?: string;
  detail: string;
  tooltip: { title: string; lines: string[] };
}

const SENTINEL_RE = /⟦pill:([A-Za-z0-9_\-]+=*)⟧/g;

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 ? '='.repeat(4 - (norm.length % 4)) : '';
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodePill(p: PillPayload): string {
  return `⟦pill:${b64urlEncode(JSON.stringify(p))}⟧`;
}

export function decodePill(token: string): PillPayload | null {
  const m = token.match(/^⟦pill:([A-Za-z0-9_\-]+=*)⟧$/);
  if (!m) return null;
  try {
    const obj = JSON.parse(b64urlDecode(m[1]));
    if (!obj || typeof obj !== 'object' || !obj.kind || !obj.detail) return null;
    return obj as PillPayload;
  } catch {
    return null;
  }
}

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'pill'; token: string; payload: PillPayload };

export function parseSegments(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTINEL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) });
    const payload = decodePill(m[0]);
    if (payload) out.push({ kind: 'pill', token: m[0], payload });
    else out.push({ kind: 'text', text: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function expandPills(text: string): string {
  return text.replace(SENTINEL_RE, (full) => {
    const p = decodePill(full);
    return p ? p.detail : full;
  });
}

// buildPillFromTarget moved to ./referenceRegistry (single source of truth for
// referenceable units). Re-exported here for back-compat with existing imports.
export { buildPillFromTarget } from './referenceRegistry';
