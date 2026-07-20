// @forgeax/editor-core — export-surface-snapshot.test.ts
//
// AC-01 export-surface snapshot baseline + test (M1 w1).
//
// Extracts the TYPE SIGNATURES (from the TypeScript compiler API, NoTruncation)
// of all 62 barrel-re-exported store symbols (58 value + 4 type) at
// packages/core/src/index.ts:164-225. The extracted signatures are compared
// against a committed baseline fixture (__tests__/fixtures/export-surface-baseline.json).
//
// BASELINE RULE (plan-strategy D-9, requirements boundary #5):
//   The baseline MUST be generated from the PRE-split store.ts state. This test
//   is committed BEFORE any store refactoring begins. The fixture is checked in
//   as part of this commit — subsequent store decomposition passes through this
//   gate to guarantee the barrel contract is unchanged.
//
// Why TypeScript compiler API instead of `tsc --emitDeclarationOnly`:
//   ts.createProgram + checker.typeToString with NoTruncation produces
//   structured { name, signature } JSON directly — no .d.ts parsing step.
//   D-9 explicitly permits either path; the compiler-API route is chosen
//   because it produces the ground-truth type representation the typechecker
//   itself uses, with zero intermediate format risk.
//
// FALSIFICATION CHECK (plan-strategy §5.4, to be run once after initial commit):
//   Temporarily change a store export signature (e.g. add an optional parameter
//   to getSelection) → test MUST go RED with a symbol-level diff showing the
//   changed symbol → REVERT the change → test back to green.
//   This proves the gate has discrimination power (not a no-op).
//   Record the falsification confirmation in a subsequent commit message.

import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PKG_ROOT = path.resolve(import.meta.dir, '..');
const INDEX_TS = path.resolve(PKG_ROOT, 'index.ts');
const GATEWAY_TS = path.resolve(PKG_ROOT, 'io', 'gateway.ts');
const BASELINE_PATH = path.resolve(
  import.meta.dir,
  'fixtures',
  'export-surface-baseline.json',
);
// M3-w9 (feat-20260709-...-wave2-c-domain-scen): the EditGateway public-entry
// surface freeze baseline (AC-03 / plan-strategy §2 D-4). Frozen SEPARATELY from
// the barrel store surface above so the M3 gateway detail-sinking refactor (w10)
// has a machine witness that no public method signature drifted. The listOps()
// self-introspection output is frozen alongside (OpDescriptor[] equivalence).
const GATEWAY_SURFACE_BASELINE_PATH = path.resolve(
  import.meta.dir,
  'fixtures',
  'gateway-surface-baseline.json',
);
const LISTOPS_INTROSPECTION_BASELINE_PATH = path.resolve(
  import.meta.dir,
  'fixtures',
  'gateway-listops-introspection-baseline.json',
);

// ---------------------------------------------------------------------------
// TypeScript program for the barrel
// ---------------------------------------------------------------------------

function createProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  // Load the core package tsconfig
  const tsconfigPath = ts.findConfigFile(PKG_ROOT, ts.sys.fileExists, 'tsconfig.json');
  if (!tsconfigPath) {
    throw new Error(`tsconfig.json not found under ${PKG_ROOT}`);
  }

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  }

  const { options } = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );

  // Create a program rooted at the barrel entry point.
  // TypeScript auto-resolves all imports transitively (including engine submodules),
  // so the checker can resolve types of re-exported store symbols fully.
  const program = ts.createProgram({
    rootNames: [INDEX_TS],
    options: {
      ...options,
      noEmit: true,
      declaration: true, // declarationMap depends on declaration being true
      declarationMap: false, // suppress .d.ts.map output
      types: options.types, // preserve explicit types (bun)
    },
  });

  // Known-shim modules: engine-project / engine-fbx ship no .d.ts; the editor
  // provides ambient shims (types/forgeax-engine-shims.d.ts) that tsc's program
  // creation resolves via the tsconfig `include`.  Should a shim be missing or
  // tsc can't pick it up, these specific module-not-found diagnostics are NOT
  // fatal to signature extraction — the checker can still resolve re-exported
  // store symbols because store.ts imports are value-space-only through the
  // shims.  We filter them out.
  const SHIM_MODULES = ['@forgeax/engine-project', '@forgeax/engine-fbx'];
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const errors = diagnostics.filter((d) => {
    if (d.category !== ts.DiagnosticCategory.Error) return false;
    const msg = ts.flattenDiagnosticMessageText(d.messageText ?? '', '\n');
    for (const shim of SHIM_MODULES) {
      if (msg.includes(shim)) return false;
    }
    return true;
  });

  if (errors.length > 0) {
    const msg = errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText ?? '', '\n'))
      .join('\n');
    throw new Error(`Barrel compilation errors:\n${msg}`);
  }

  return { program, checker: program.getTypeChecker() };
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

interface ExportEntry {
  name: string;
  signature: string;
}

function extractBarrelReExports(
  program: ts.Program,
  checker: ts.TypeChecker,
): ExportEntry[] {
  const sf = program.getSourceFile(INDEX_TS);
  if (!sf) throw new Error(`Source file not found: ${INDEX_TS}`);

  const entries: ExportEntry[] = [];

  // Walk the barrel AST looking for export declarations from './store/store'.
  // The barrel has exactly two such declarations:
  //   export { bus, dispatch, ..., useMeshStats } from './store/store';  (lines 165-224)
  //   export type { SceneFileEntry, PlayConfig, SelectedAsset, MeshStats } from './store/store'; (line 225)
  ts.forEachChild(sf, (node) => {
    if (!ts.isExportDeclaration(node)) return;
    if (!node.moduleSpecifier) return;

    const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
    if (!specifier.startsWith('./store/store')) return;

    // Named exports clause
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return;

    const isTypeOnly = node.isTypeOnly;

    for (const element of node.exportClause.elements) {
      const name = element.name.text;

      // Resolve the re-exported symbol.  For `export { X } from './mod'`,
      // the local symbol at element.name is an alias — resolve it to the
      // originating declaration in store.ts.
      const localSymbol = checker.getSymbolAtLocation(element.name);
      if (!localSymbol) {
        // If the symbol can't be resolved, record a marker and continue.
        entries.push({ name, signature: '<unresolved>' });
        return;
      }

      const resolvedSymbol = (localSymbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(localSymbol)
        : localSymbol;

      // Get the type of the symbol.
      let typeStr: string;

      if (isTypeOnly) {
        // Type-only export: the "type" of a type alias / interface is the
        // declared type itself. We use getDeclaredTypeOfSymbol to get the
        // type it declares.
        typeStr = checker.typeToString(
          checker.getDeclaredTypeOfSymbol(resolvedSymbol),
          undefined,
          ts.TypeFormatFlags.NoTruncation,
        );
      } else {
        // Value export: get the type of the value (function / variable).
        // Use getTypeOfSymbolAtLocation to get the contextual type.
        const declaration = resolvedSymbol.declarations?.[0];
        if (!declaration) {
          entries.push({ name, signature: '<no declaration>' });
          return;
        }
        typeStr = checker.typeToString(
          checker.getTypeOfSymbolAtLocation(resolvedSymbol, declaration),
          undefined,
          ts.TypeFormatFlags.NoTruncation,
        );
      }

      entries.push({ name, signature: typeStr });
    }
  });

  // Sort for stable, diff-friendly comparisons.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return entries;
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe('AC-01 export-surface snapshot', () => {
  test(
    'extract barrel-re-exported store symbols via compiler API',
    () => {
      // ts.createProgram with the full editor-core + engine type graph takes
      // ~15-25 s on first run (cold cache). Warm re-runs are faster.
    const { program, checker } = createProgram();
    const entries = extractBarrelReExports(program, checker);

    // ── Sanity checks ──────────────────────────────────────────────────
    // Research F-1 established 62 barrel re-exports pre-M3. The trace-ioc M3 (AC-08)
    // SEALED 12 op setters (dispatch wrapper + setSelection/setSelectionMany/
    // toggleSelection/setGizmoMode/setHoverEntity/setFieldPreview/setAssetSelection/
    // saveDocToDisk/setSceneId/requestFrame/requestRename) off the barrel → 50.
    // feat-20260707-editor-world-fork M3 (AC-02) then DELETED rebindLoadedScene
    // (the ▶/■ Stop legacy-map rebind — no map to rebind under handle identity),
    // dropping the published store surface to 50 − 1 = 49.
    // tweak-20260709-hierarchy-delete-key-wire (keyboard-router convergence) then
    // PUBLISHED 5 asset-selection surface symbols the router + CB panel both read
    // (getAssetSelectionList / useAssetSelectionList / clearAssetSelection /
    // registerAssetSelectAllHandler / triggerAssetSelectAll) → 49 + 5 = 54. This
    // count is the machine witness that the barrel surface moved exactly as intended.
    expect(entries.length).toBe(54);

    // Every entry must be non-empty.
    for (const e of entries) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.signature.length).toBeGreaterThan(0);
    }

    // ── Baseline check ─────────────────────────────────────────────────
    // Read the committed baseline fixture. If it doesn't exist yet, this is
    // a first-run bootstrapping scenario — write it and skip the comparison.
    if (!existsSync(BASELINE_PATH)) {
      writeFileSync(BASELINE_PATH, JSON.stringify(entries, null, 2) + '\n', 'utf8');
      console.log(
        `[AC-01] Baseline fixture written to ${BASELINE_PATH} (${entries.length} entries).`,
      );
      console.log(
        '[AC-01] Re-run the test to verify baseline comparison.',
      );
      // This is not a test pass/fail — the test will pass on the next run
      // after the baseline is committed.  Mark as a "baseline created" event.
      // We DON'T skip with test.todo — the test itself proves the extraction
      // mechanism works (entries.length=62, no unresolved symbols, etc.).
      return; // baseline just created, no comparison to run
    }

    const raw = readFileSync(BASELINE_PATH, 'utf8');
    const baseline: ExportEntry[] = JSON.parse(raw);

    // ── Symbol-level comparison ─────────────────────────────────────────
    // Compare entry-by-entry.  Produce a detailed diff on mismatch.
    const baselineMap = new Map(baseline.map((e) => [e.name, e.signature]));
    const currentMap = new Map(entries.map((e) => [e.name, e.signature]));

    const mismatches: string[] = [];
    const onlyInBaseline: string[] = [];
    const onlyInCurrent: string[] = [];

    for (const [name, sig] of baselineMap) {
      const curSig = currentMap.get(name);
      if (curSig === undefined) {
        onlyInBaseline.push(name);
      } else if (curSig !== sig) {
        mismatches.push(
          `  ${name}:\n` +
            `    baseline: ${sig}\n` +
            `    current:  ${curSig}`,
        );
      }
    }

    for (const name of currentMap.keys()) {
      if (!baselineMap.has(name)) {
        onlyInCurrent.push(name);
      }
    }

    const errors: string[] = [];
    if (mismatches.length > 0) {
      errors.push(
        `${mismatches.length} symbol(s) have signature drift:\n${mismatches.join('\n')}`,
      );
    }
    if (onlyInBaseline.length > 0) {
      errors.push(
        `${onlyInBaseline.length} symbol(s) removed from barrel: ${onlyInBaseline.join(', ')}`,
      );
    }
    if (onlyInCurrent.length > 0) {
      errors.push(
        `${onlyInCurrent.length} symbol(s) added to barrel: ${onlyInCurrent.join(', ')}`,
      );
    }

    if (errors.length > 0) {
      throw new Error(
        `AC-01 barrel export surface changed!\n\n${errors.join('\n\n')}\n\n` +
          `Update baseline file at ${BASELINE_PATH} ONLY after human review ` +
          `(auto-rerecord is forbidden per plan-strategy D-9).`,
      );
    }

    // All good.
    expect(mismatches.length).toBe(0);
    expect(onlyInBaseline.length).toBe(0);
    expect(onlyInCurrent.length).toBe(0);
  },
  60_000,
);
});

// ---------------------------------------------------------------------------
// AC-03 EditGateway public-entry surface freeze (M3-w9)
// ---------------------------------------------------------------------------
//
// The M3 refactor (w10) sinks NON-ENTRY implementation detail (labelOf /
// entityOf / step / nextOpHandleId free functions + buildQueryFn assembly +
// history/step construction) out of gateway.ts into io/gateway-history.ts +
// io/gateway-query.ts. plan-strategy §2 D-4 + requirements AC-03 / OOS-2 demand
// the EditGateway PUBLIC ENTRY FACE stay byte-for-byte frozen through that move:
// dispatch / begin / update / commit / cancel / undo / redo / listOps /
// defineOp / querySnapshot (+ the rest of the public class members) keep their
// exact type signatures, and listOps() self-introspection output stays
// equivalent. This block is the machine witness for that freeze — it extracts
// each public class member's signature via the same compiler-API route as the
// barrel block above and diffs against a committed baseline.
//
// This freezes the SIGNATURE of the public surface (the AI-user self-introspection
// contract, charter P2/F1). The stronger "consumers typecheck with zero edits +
// no new `as`" judgement (AC-03 application-point) is proven separately in w11 by
// running `bun run typecheck` across the real import→call chains — that is the
// live consumer path the requirements mandate over an isolated *.test-d.ts.

interface MemberEntry {
  name: string;
  signature: string;
}

function extractGatewayPublicSurface(
  program: ts.Program,
  checker: ts.TypeChecker,
): MemberEntry[] {
  const sf = program.getSourceFile(GATEWAY_TS);
  if (!sf) throw new Error(`Source file not found: ${GATEWAY_TS}`);

  // Locate the EditGateway class declaration.
  let classDecl: ts.ClassDeclaration | undefined;
  ts.forEachChild(sf, (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'EditGateway') {
      classDecl = node;
    }
  });
  if (!classDecl) throw new Error('EditGateway class declaration not found');

  const entries: MemberEntry[] = [];

  const hasPrivateOrProtected = (mods: ts.NodeArray<ts.ModifierLike> | undefined): boolean => {
    if (!mods) return false;
    for (const m of mods) {
      if (m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword) {
        return true;
      }
    }
    return false;
  };

  for (const member of classDecl.members) {
    // A member is part of the PUBLIC surface iff:
    //   - it has a name (skip index signatures / static blocks)
    //   - it is NOT declared private/protected
    //   - its name does not start with `_` (the file's convention for private state)
    // Methods, getters, and public property/arrow-fn members (e.g. `trace`,
    // readonly `ledger`) all count — they are the AI-user consumable surface.
    if (
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessor(member) ||
      ts.isPropertyDeclaration(member)
    ) {
      const nameNode = member.name;
      if (!nameNode || !ts.isIdentifier(nameNode)) continue;
      const name = nameNode.text;
      if (name.startsWith('_')) continue;
      if (hasPrivateOrProtected(member.modifiers)) continue;

      const symbol = checker.getSymbolAtLocation(nameNode);
      if (!symbol) {
        entries.push({ name, signature: '<unresolved>' });
        continue;
      }
      const type = checker.getTypeOfSymbolAtLocation(symbol, member);
      const isStatic = (member.modifiers ?? []).some(
        (m) => m.kind === ts.SyntaxKind.StaticKeyword,
      );
      const signature = checker.typeToString(
        type,
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      );
      entries.push({ name: `${isStatic ? 'static ' : ''}${name}`, signature });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function diffMembers(
  baseline: MemberEntry[],
  current: MemberEntry[],
): { mismatches: string[]; onlyInBaseline: string[]; onlyInCurrent: string[] } {
  const baselineMap = new Map(baseline.map((e) => [e.name, e.signature]));
  const currentMap = new Map(current.map((e) => [e.name, e.signature]));
  const mismatches: string[] = [];
  const onlyInBaseline: string[] = [];
  const onlyInCurrent: string[] = [];
  for (const [name, sig] of baselineMap) {
    const curSig = currentMap.get(name);
    if (curSig === undefined) onlyInBaseline.push(name);
    else if (curSig !== sig) {
      mismatches.push(`  ${name}:\n    baseline: ${sig}\n    current:  ${curSig}`);
    }
  }
  for (const name of currentMap.keys()) {
    if (!baselineMap.has(name)) onlyInCurrent.push(name);
  }
  return { mismatches, onlyInBaseline, onlyInCurrent };
}

describe('AC-03 EditGateway public-entry surface freeze (M3-w9)', () => {
  test(
    'public method/getter/property signatures match committed baseline',
    () => {
      const { program, checker } = createProgram();
      const entries = extractGatewayPublicSurface(program, checker);

      // Sanity: the ten frozen entry methods (plan-strategy §2 D-4 / AC-03)
      // must all be present in the extracted public surface.
      const names = new Set(entries.map((e) => e.name));
      const FROZEN_ENTRY = [
        'dispatch', 'begin', 'update', 'commit', 'cancel',
        'undo', 'redo', 'listOps', 'defineOp', 'buildQueryFn',
      ];
      for (const m of FROZEN_ENTRY) {
        expect(names.has(m)).toBe(true);
      }
      for (const e of entries) {
        expect(e.name.length).toBeGreaterThan(0);
        expect(e.signature.length).toBeGreaterThan(0);
        expect(e.signature).not.toBe('<unresolved>');
      }

      if (!existsSync(GATEWAY_SURFACE_BASELINE_PATH)) {
        writeFileSync(
          GATEWAY_SURFACE_BASELINE_PATH,
          JSON.stringify(entries, null, 2) + '\n',
          'utf8',
        );
        console.log(
          `[AC-03] Gateway surface baseline written to ${GATEWAY_SURFACE_BASELINE_PATH} (${entries.length} members).`,
        );
        return;
      }

      const baseline: MemberEntry[] = JSON.parse(
        readFileSync(GATEWAY_SURFACE_BASELINE_PATH, 'utf8'),
      );
      const { mismatches, onlyInBaseline, onlyInCurrent } = diffMembers(baseline, entries);

      const errs: string[] = [];
      if (mismatches.length > 0) {
        errs.push(`${mismatches.length} public member(s) drifted:\n${mismatches.join('\n')}`);
      }
      if (onlyInBaseline.length > 0) {
        errs.push(`${onlyInBaseline.length} public member(s) removed: ${onlyInBaseline.join(', ')}`);
      }
      if (onlyInCurrent.length > 0) {
        errs.push(`${onlyInCurrent.length} public member(s) added: ${onlyInCurrent.join(', ')}`);
      }
      if (errs.length > 0) {
        throw new Error(
          `AC-03 EditGateway public entry surface changed!\n\n${errs.join('\n\n')}\n\n` +
            `The M3 refactor may sink only NON-ENTRY implementation detail (plan-strategy §2 D-4). ` +
            `Update ${GATEWAY_SURFACE_BASELINE_PATH} ONLY after human review.`,
        );
      }

      expect(mismatches.length).toBe(0);
      expect(onlyInBaseline.length).toBe(0);
      expect(onlyInCurrent.length).toBe(0);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// AC-03 listOps() self-introspection output freeze (M3-w9)
// ---------------------------------------------------------------------------
//
// listOps() is the AI-user "what ops can I call?" self-introspection entry
// (charter P2/F1). The M3 detail-sinking must NOT alter its output. This block
// captures the runtime OpDescriptor[] from a real EditGateway instance (builtin
// ops only — same shape play-runtime/panels/__forgeaxEval consumers observe) and
// diffs it against a committed baseline. Runtime capture (not compiler-API) is
// deliberate: it freezes the actual data an AI caller receives, one call → full
// capability set (plan-strategy §8 API).

describe('AC-03 listOps() self-introspection output freeze (M3-w9)', () => {
  test('builtin OpDescriptor[] matches committed baseline', () => {
    // Import at test time so the catalog is fully registered (builtin ops are
    // registered as a side effect of importing the gateway/catalog chain).
    const { EditGateway } = require('../io/gateway') as typeof import('../io/gateway');
    const { createEditSession } = require('../session/document') as typeof import('../session/document');
    const gw = new EditGateway(createEditSession());

    // Normalize to a stable, diff-friendly, JSON-round-trip-safe shape, sorted by id.
    // Filter to source='builtin': the catalog is a PROCESS-GLOBAL registry, so
    // sibling test files that call defineOp leak `source='defined'` ops into it
    // when the whole suite runs in one process. The frozen contract is the
    // BUILTIN self-introspection surface (plan-strategy §8: one call → full
    // built-in capability set); runtime-defined ops are not part of it. Filtering
    // by source makes the freeze isolation-safe AND semantically exact.
    const ops = [...gw.listOps()]
      .filter((o) => o.source === 'builtin')
      .map((o) => ({
        id: o.id,
        domain: o.domain,
        source: o.source,
        argsSchema: o.argsSchema ?? null,
        ...(o.title !== undefined ? { title: o.title } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      expect(o.id.length).toBeGreaterThan(0);
      expect(['document', 'session', 'transient']).toContain(o.domain);
      expect(['builtin', 'defined']).toContain(o.source);
    }

    if (!existsSync(LISTOPS_INTROSPECTION_BASELINE_PATH)) {
      writeFileSync(
        LISTOPS_INTROSPECTION_BASELINE_PATH,
        JSON.stringify(ops, null, 2) + '\n',
        'utf8',
      );
      console.log(
        `[AC-03] listOps introspection baseline written (${ops.length} ops).`,
      );
      return;
    }

    const baseline = JSON.parse(
      readFileSync(LISTOPS_INTROSPECTION_BASELINE_PATH, 'utf8'),
    );
    // Full structural equality: any id/domain/source/argsSchema/title drift fails.
    expect(ops).toEqual(baseline);
  });
});
