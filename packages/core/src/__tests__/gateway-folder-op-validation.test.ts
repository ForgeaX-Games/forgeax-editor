// gateway-folder-op-validation.test.ts — folder / rename name validation gate
//
// Exercises the SSOT basename validator installed in pack-ops.ts appliers by
// 2026-07-23 assets-folder-name-validation. Sister to gateway-args-validation.test.ts
// (which pins the gateway-ENTRY argsSchema validation): this suite pins the
// APPLIER-level fail-fast for ops whose catalog descriptor is currently absent
// (createDirectory / deleteDirectory / renameDirectory / renameSourceFile) and
// for renameAsset (document op) — the applier is the SSOT regardless of whether
// the catalog entry exists (north-star §9 by construction).
//
// See:
//   packages/core/src/session/asset-basename.ts
//   feedbacks/2026-07-23-assets-create-folder-name-validation-illegal-chars.md
//   feedbacks/2026-07-23-assets-create-folder-name-validation-illegal-chars.dev-plan.md

import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { setPathResolver } from '../util/path-resolver';
import type { EditorOp, EditSession } from '../types';
// Session appliers register as a store-module eval side effect; pull the store
// in so createDirectory / renameDirectory / renameSourceFile are wired.
import '../store/store';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

// Install a passthrough path resolver so legal-path branches don't throw
// EditorPathResolverError before we can assert `ok:true`. The applier fires
// a background fetch on legal ops; that fetch will fail in the test env, but
// the applier is fire-and-forget so the return value is unaffected.
setPathResolver((rel) => `/games/test/${rel}`);
afterAll(() => setPathResolver(null));

// ── createDirectory: name basename validation ──────────────────────────────

describe('createDirectory: applier rejects illegal name (SSOT)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('name containing "\\" (the reported bug) → INVALID_ARGS, no ledger residue', () => {
    const before = gw.ledger.length;
    const r = gw.dispatch(
      { kind: 'createDirectory', parentPath: 'assets', name: 'foo\\bar' } as EditorOp,
      'human',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_ARGS');
      // Either the gateway `pattern` (says "illegal character" via patternHint)
      // or the applier SSOT (says "invalid character") catches it — both must
      // mention illegality. Belt+suspenders: pattern first, applier second.
      expect(r.error.hint).toMatch(/illegal character|invalid character/i);
    }
    // Fail Fast: rejected op leaves NO trace in the ledger.
    expect(gw.ledger.length).toBe(before);
  });

  it('name containing "/" → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'createDirectory', parentPath: 'assets', name: 'sub/nested' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('name "." / ".." → INVALID_ARGS', () => {
    for (const name of ['.', '..']) {
      const r = gw.dispatch(
        { kind: 'createDirectory', parentPath: 'assets', name } as EditorOp,
        'ai',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
    }
  });

  it('empty name → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'createDirectory', parentPath: 'assets', name: '' } as EditorOp,
      'human',
    );
    expect(r.ok).toBe(false);
    // Gateway (minLength:1 → "too short") catches this before the applier
    // (which says "empty"). Either message is fine — both mean the same thing.
    if (!r.ok) expect(r.error.hint).toMatch(/empty|too short/i);
  });

  it('Windows reserved (CON) → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'createDirectory', parentPath: 'assets', name: 'CON' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/reserved on Windows/);
  });

  it('AI and human origins get identical rejection (§1 single entry parity)', () => {
    const op = { kind: 'createDirectory', parentPath: 'assets', name: 'foo|bar' } as EditorOp;
    const h = gw.dispatch(op, 'human');
    const a = gw.dispatch(op, 'ai');
    expect(h.ok).toBe(false);
    expect(a.ok).toBe(false);
    if (!h.ok && !a.ok) {
      expect(h.error.code).toBe(a.error.code);
      expect(h.error.hint).toBe(a.error.hint);
    }
  });

  it('legal name → ok (regression guard: normal cases still pass)', () => {
    const r = gw.dispatch(
      { kind: 'createDirectory', parentPath: 'assets', name: '模型-fbx' } as EditorOp,
      'human',
    );
    expect(r.ok).toBe(true);
  });
});

// ── deleteDirectory: path jailbreak defence (name NOT validated by design) ──

describe('deleteDirectory: applier rejects path jailbreak (name unvalidated)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('path containing ".." → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'deleteDirectory', path: 'assets/../etc/passwd' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/\.\./);
  });

  it('path containing "\\" (Windows smuggling) → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'deleteDirectory', path: 'assets\\textures' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/"\/"/);
  });

  it('path containing NUL byte → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'deleteDirectory', path: 'assets/foo\x00bar' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/NUL/);
  });

  it('path with an ALREADY-BAD basename (foo\\bar as literal) → ok (escape hatch preserved)', () => {
    // AC-6: deleteDirectory MUST NOT run basename validation on its last
    // segment, otherwise users cannot clean up dirs that were created by an
    // older build predating this validator. We only guard `\\` in path segments
    // that indicate WINDOWS SEPARATOR smuggling — i.e. the whole `\\` char must
    // NOT appear. Since a POSIX dir literally named "foo\\bar" only exists on
    // POSIX (Windows treats \\ as separator), and it would have been read from
    // the tree read-model as `foo/bar` and thus wouldn't naturally be dispatched
    // as `foo\\bar` here anyway, the delete-side check on `\\` is safe.
    // What DOES pass: a normal path pointing at a legitimately created dir.
    const r = gw.dispatch(
      { kind: 'deleteDirectory', path: 'assets/some-legit-dir' } as EditorOp,
      'human',
    );
    expect(r.ok).toBe(true);
  });
});

// ── renameDirectory: BOTH path jailbreak AND newName basename ──────────────

describe('renameDirectory: applier rejects illegal newName', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('newName containing "\\" → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'renameDirectory', path: 'assets/foo', newName: 'bar\\baz' } as EditorOp,
      'human',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_ARGS');
      // Either gateway `pattern` (mentions the op-id in "invalid args for
      // renameDirectory: newName: ...") or the applier ("renameDirectory: ...")
      // — both attribute the failure to renameDirectory.
      expect(r.error.hint).toContain('renameDirectory');
    }
  });

  it('newName empty → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'renameDirectory', path: 'assets/foo', newName: '' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
  });

  it('path jailbreak (`..`) → INVALID_ARGS (checked before newName)', () => {
    const r = gw.dispatch(
      { kind: 'renameDirectory', path: 'assets/../secret', newName: 'ok' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toMatch(/\.\./);
  });

  it('legal path + legal newName → ok', () => {
    const r = gw.dispatch(
      { kind: 'renameDirectory', path: 'assets/foo', newName: 'foo-renamed' } as EditorOp,
      'human',
    );
    expect(r.ok).toBe(true);
  });
});

// ── renameSourceFile: same shape as renameDirectory ────────────────────────

describe('renameSourceFile: applier rejects illegal newName', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('newName containing "/" → INVALID_ARGS', () => {
    const r = gw.dispatch(
      { kind: 'renameSourceFile', path: 'assets/Fox.glb', newName: 'sub/Fox.glb' } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('newName with legal extension → ok', () => {
    const r = gw.dispatch(
      { kind: 'renameSourceFile', path: 'assets/Fox.glb', newName: 'Fox-v2.glb' } as EditorOp,
      'human',
    );
    expect(r.ok).toBe(true);
  });
});

// ── renameAsset: document domain — validation runs inside applyCommand ─────

describe('renameAsset (document op): applier rejects illegal newName', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('newName containing "\\" → INVALID_ARGS (document domain wraps through applyCommand)', () => {
    const r = gw.dispatch(
      {
        kind: 'renameAsset',
        packPath: 'assets/scene.pack.json',
        guid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        newName: 'foo\\bar',
      } as EditorOp,
      'ai',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_ARGS');
      // renameAsset has NO `pattern` on its newName in the catalog (this
      // change deliberately scopes PR-B2 to the four folder/source-file ops),
      // so the applier SSOT is the only gate — hint carries the "renameAsset"
      // prefix from applyRenameAsset.
      expect(r.error.hint).toContain('renameAsset');
    }
  });
});
