// w2 — TDD: VAG_ACTION dead-code removal guards + AC-04 trust-field type locks.
//
// feat-20260708-editor-io-layer-enrich-registry-action-editgateway M1:
//   AC-04 (type asserts, green NOW — this loop only has to NOT regress): the
//         OpDescriptor shape has no `capability` member, and dispatch's origin
//         parameter is exactly 'human' | 'ai' with no trust/authorization arg.
//   AC-02 / AC-05 (grep residual asserts, RED before w4 deletion / GREEN after):
//         the VAG_ACTION channel (registerPanelAction / PanelActionDef /
//         PanelActionResult / VagAction* / VAG_ACTION) and the `def.run` black-box
//         execution path leave ZERO residual in editor production source once w4
//         deletes them — i.e. there is no gateway-bypassing run() path.
//
// Constraints from upstream:
//   OOS-4 (requirements out-of-scope): trust/authorization fields (capability /
//         timeoutMs / requireConfirm) never sink into OpDescriptor or dispatch.
//   research §Finding B1: OpDescriptor currently has no capability member and
//         dispatch has no trust param — this loop only guards "do not add".
//   research §Finding A1: reverse-condition grep hit=0 (no external consumer);
//         all residuals live in the three w4 deletion-target files.
//
// FOOTGUN 1 (inherited from gateway-grep-assertions.test.ts): use a RECURSIVE
// glob (packages/**/src/**) — a non-recursive packages/*/src reports a FALSE
// zero. Use git grep -nP (PCRE) so \b word boundaries actually apply on this
// platform.
// FOOTGUN 2 (this loop): the environment's global git config sets
// submodule.recurse=true, so a bare `git grep` DESCENDS into the packages/engine
// | interface | platform-io submodules. AC-02/AC-05 gate EDITOR-PROPER source
// only — the interface submodule has its own unrelated host-side ActionRegistry
// (`def.run(args, {token})`, OOS-3, not a deletion target). We pass
// --no-recurse-submodules so the scan stays inside editor source regardless of
// the caller's git config.
//
// Anchors:
//   plan-tasks.json w2; plan-strategy §5.3 AC-02 / AC-04; §2 D-2.

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { OpDescriptor } from '../io/catalog';
import type { CommandOrigin } from '../io/gateway';

// Repo root: this file is at <root>/packages/core/src/__tests__/, four dirs up.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');

/**
 * Run `git grep -nP` and return matching lines (empty array = zero hits).
 * git grep exits 1 with no output when there are no matches; that is success.
 */
function gitGrep(pattern: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '--no-recurse-submodules', '-nP', pattern, '--', ...pathspecs],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return out.split('\n').filter((l) => l.trim().length > 0);
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1 && !(err.stdout && err.stdout.trim())) return [];
    if (err.stdout && err.stdout.trim()) {
      return err.stdout.split('\n').filter((l) => l.trim().length > 0);
    }
    throw e;
  }
}

// Editor production source (recursive globs; git grep does not descend into
// submodules, so packages/engine|interface|platform-io are naturally excluded).
const SRC_GLOBS = ['packages/**/src/**', 'src/**'];

// ── AC-04: trust fields never sink into OpDescriptor / dispatch (type locks) ───
// These are compile-time assertions (checked by `bun run typecheck`). If a future
// change adds `capability` to OpDescriptor or a trust arg to dispatch, the type
// below stops being `true` and typecheck goes red.

// True iff K is NOT a key of T.
type Absent<K extends PropertyKey, T> = K extends keyof T ? false : true;
// Compile-time assert helper: only accepts the literal `true`.
type Assert<T extends true> = T;

// OpDescriptor must not carry a capability / trust member (OOS-4).
type _NoCapability = Assert<Absent<'capability', OpDescriptor>>;
type _NoTimeoutMs = Assert<Absent<'timeoutMs', OpDescriptor>>;
type _NoRequireConfirm = Assert<Absent<'requireConfirm', OpDescriptor>>;

// dispatch's origin is EXACTLY 'human' | 'ai' — no trust/authorization widening.
type OriginIsHumanOrAi = [CommandOrigin] extends ['human' | 'ai']
  ? (['human' | 'ai'] extends [CommandOrigin] ? true : false)
  : false;
type _OriginLocked = Assert<OriginIsHumanOrAi>;

describe('AC-04 — trust fields absent from OpDescriptor / dispatch (w2)', () => {
  it('the compile-time type locks hold (see _NoCapability / _OriginLocked above)', () => {
    // Reference the type aliases so tsc keeps them in scope; the real assertion
    // is the type-level Assert<> — this runtime body is a placeholder.
    const witness: OriginIsHumanOrAi = true;
    expect(witness).toBe(true);
  });

  it('a runtime OpDescriptor exposes no capability/timeoutMs/requireConfirm key', () => {
    const sample: OpDescriptor = {
      id: 'x', domain: 'document', argsSchema: null, source: 'builtin',
    };
    expect(Object.keys(sample)).not.toContain('capability');
    expect(Object.keys(sample)).not.toContain('timeoutMs');
    expect(Object.keys(sample)).not.toContain('requireConfirm');
  });
});

// ── AC-02 / AC-05: VAG_ACTION residual is zero after w4 (RED before, GREEN after) ──

describe('AC-05 — VAG_ACTION dead code leaves zero residual in editor source (w2)', () => {
  it('no registerPanelAction / PanelActionDef / PanelActionResult identifier survives', () => {
    const pattern = '\\b(registerPanelAction|PanelActionDef|PanelActionResult)\\b';
    const hits = gitGrep(pattern, SRC_GLOBS).filter((l) => !l.includes('.test.'));
    expect(hits).toEqual([]);
  });

  it('no VagAction* / VAG_ACTION identifier survives', () => {
    const pattern = '\\b(VagAction\\w*|VAG_ACTION\\w*)\\b';
    const hits = gitGrep(pattern, SRC_GLOBS).filter((l) => !l.includes('.test.'));
    expect(hits).toEqual([]);
  });
});

describe('AC-02 — no gateway-bypassing run() black-box execution path (w2)', () => {
  it('no def.run(...) direct-execution call survives in editor source', () => {
    // action-bridge.ts held the only `def.run(args)` — a closure invoked outside
    // the gateway ledger. After w4 deletes it, dispatch(EditorOp, origin) is the
    // sole mutation path (AC-02: every call lands on dispatch, not a run closure).
    const pattern = '\\bdef\\.run\\b';
    const hits = gitGrep(pattern, SRC_GLOBS).filter((l) => !l.includes('.test.'));
    expect(hits).toEqual([]);
  });
});
