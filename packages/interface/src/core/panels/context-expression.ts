import type { ContextKeysApi } from '../extension-foundation/context-keys';

function parseLiteral(raw: string): unknown {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  const n = Number(s);
  if (!Number.isNaN(n) && s !== '') return n;
  return s;
}

function valueFor(token: string, contextKeys: ContextKeysApi): unknown {
  const trimmed = token.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return parseLiteral(trimmed);
  }
  if (/^(true|false|null|-?\d+(?:\.\d+)?)$/.test(trimmed)) return parseLiteral(trimmed);
  return contextKeys.get(trimmed);
}

function evalAtom(atom: string, contextKeys: ContextKeysApi): boolean {
  let expr = atom.trim();
  if (!expr) return true;
  let negate = false;
  while (expr.startsWith('!')) {
    negate = !negate;
    expr = expr.slice(1).trim();
  }

  const neq = expr.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neq) {
    const result = valueFor(neq[1] ?? '', contextKeys) !== parseLiteral(neq[2] ?? '');
    return negate ? !result : result;
  }
  const eq = expr.match(/^(.+?)\s*==\s*(.+)$/);
  if (eq) {
    const result = valueFor(eq[1] ?? '', contextKeys) === parseLiteral(eq[2] ?? '');
    return negate ? !result : result;
  }

  const result = Boolean(valueFor(expr, contextKeys));
  return negate ? !result : result;
}

export function evaluateContextExpression(
  expression: string | undefined,
  contextKeys: ContextKeysApi,
  fallback: boolean,
): boolean {
  const expr = expression?.trim();
  if (!expr) return fallback;
  return expr
    .split('||')
    .some((orPart) => orPart.split('&&').every((andPart) => evalAtom(andPart, contextKeys)));
}

export function getContextExpressionKeys(expression: string | undefined): readonly string[] {
  if (!expression) return [];
  const keys = new Set<string>();
  for (const match of expression.matchAll(/[A-Za-z_][\w.:-]*/g)) {
    const token = match[0];
    if (token === 'true' || token === 'false' || token === 'null') continue;
    keys.add(token);
  }
  return [...keys];
}
