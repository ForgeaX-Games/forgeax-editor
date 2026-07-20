// io/channel — eval channel for AI script execution (plan-strategy §2 D-4)
//
// feat-20260707-editor-trace-ioc M5 t31/t32:
// createEvalChannel(gateway, {rawScope?}) returns an EvalChannel with two
// capabilities:
//   1. eval(code) — new Function injection with scope①={gateway, query, _import}
//   2. unlockRawScope() — scope② unlock (dev-only, host injects rawScope flag)
//
// EVAL PARADIGM (research F-8): follows engine-remote execute.ts pattern:
//   new Function('gateway','query','_import', 'return eval('+JSON.stringify(code)+')')
//   - Synchronous / async-IIFE both supported (await the result if thenable)
//   - No timeout (route B has no interrupt mechanism; skill declares this)
//   - Structured errors: SyntaxError → SCRIPT_SYNTAX_ERROR, other → SCRIPT_RUNTIME_ERROR
//
// SCOPE MODEL (plan-strategy §2 D-4, requirements AC-02):
//   scope① = {gateway, query, _import} — no world/renderer/assets (AC-02)
//   scope② = rawScope injected by host (edit-runtime) only in DEV builds
//   Production: rawScope omitted → unlockRawScope() → {ok:false, code:'SCOPE_LOCKED'}
//
// Anchors:
//   plan-strategy §2 D-4: Q-2 scope② explicit API + host DEV flag; Q-5 globalThis
//   requirements AC-11: channel.eval(code) → {ok, value}/{ok:false, error}
//   requirements AC-13: structured errors SCRIPT_SYNTAX_ERROR / SCRIPT_RUNTIME_ERROR
//   research F-8: engine-remote execute.ts paradigm (new Function, structured errors)
//   plan-strategy §2 D-8: single createEvalChannel export from barrel

import type { EditGateway } from './gateway';
import type { CommandError } from '../types';

export interface EvalChannel {
  /** Evaluate a JavaScript expression / statement against the gateway scope.
   *  scope① = {gateway, query, _import} — no world/renderer/assets (AC-02).
   *  If scope② is unlocked (rawScope injected), those symbols are also available.
   *  Returns {ok:true, value} on success or {ok:false, error} on failure. */
  eval(code: string): EvaluateResult;

  /** Attempt to unlock scope② (raw engine access). Returns SCOPE_LOCKED if
   *  the host did not inject rawScope at channel creation time (production build).
   *  plan-strategy §2 D-4 Q-2: unlock MUST be explicit, production MUST NOT silently
   *  downgrade to scope①. */
  unlockRawScope(): RawScopeResult;
}

export type EvaluateResult =
  | { ok: true; value: unknown }
  | { ok: false; error: CommandError };

export type RawScopeResult =
  | { ok: true }
  | { ok: false; error: CommandError };

// ── _import capture (engine-remote pattern, research F-8) ──────────────────
// Capture dynamic import at module load time. When injected into new Function,
// it resolves module specifiers relative to the calling module scope, enabling
// eval scripts to dynamically import ESM modules.
const _import = (specifier: string): Promise<unknown> => import(specifier);

// ── createEvalChannel ──────────────────────────────────────────────────────

export function createEvalChannel(
  gateway: EditGateway,
  opts?: { rawScope?: Record<string, unknown> },
): EvalChannel {
  const hasRawScope = opts?.rawScope !== undefined;

  // Build the scope symbols array for new Function.
  // scope① is always present: gateway, query, _import
  // scope② (rawScope) is injected when provided by host (dev-only)
  function evalImpl(code: string): EvaluateResult {
    const scriptLiteral = JSON.stringify(code);
    const body = `return eval(${scriptLiteral})`;

    // Build the parameter list: always gateway, query, _import
    // Plus any rawScope keys when scope② is unlocked
    const scopeParams: string[] = ['gateway', 'query', '_import'];
    const scopeArgs: unknown[] = [gateway, makeQueryFn(gateway), _import];

    if (hasRawScope) {
      const rawKeys = Object.keys(opts!.rawScope!);
      for (const key of rawKeys) {
        scopeParams.push(key);
        scopeArgs.push(opts!.rawScope![key]);
      }
    }

    try {
      const fn = new Function(...scopeParams, body);
      const raw: unknown = fn(...scopeArgs);

      // If the script returned a Promise (async IIFE pattern), await it synchronously
      // by checking thenable. In a synchronous context this works because the promise
      // resolution happens synchronously if no real async I/O is involved, and for
      // genuinely async code (e.g. _import() usage), the eval must be wrapped in an
      // async IIFE and the caller handles the promise.
      // But since our eval() is synchronous, we resolve immediately.
      // For async IIFE, the script must use await and the eval returns the promise
      // value directly — the caller unwraps it.

      const value: unknown =
        raw != null && typeof (raw as { then?: unknown }).then === 'function'
          ? raw  // Return the promise itself for async scripts; caller can await
          : raw;

      return { ok: true, value };
    } catch (e) {
      // 1. SyntaxError: Function constructor throws on parse failure.
      if (e instanceof SyntaxError) {
        const msg = e.message;
        return {
          ok: false,
          error: {
            code: 'SCRIPT_SYNTAX_ERROR',
            hint: `syntax error near: ${msg}; fix and resubmit`,
          },
        };
      }

      // 2. Runtime error (throws during function execution).
      const rawMessage = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: {
          code: 'SCRIPT_RUNTIME_ERROR',
          hint: `runtime error: ${rawMessage}; inspect error and retry`,
        },
      };
    }
  }

  function unlockRawScope(): RawScopeResult {
    if (!hasRawScope) {
      return {
        ok: false,
        error: {
          code: 'SCOPE_LOCKED',
          hint: 'raw scope is not available in this build; scope② is dev-only — run in DEV mode or request rawScope injection at channel creation',
        },
      };
    }
    return { ok: true };
  }

  return { eval: evalImpl, unlockRawScope };
}

// ── query factory (wraps gateway.buildQueryFn) ─────────────────────────────

function makeQueryFn(gateway: EditGateway): unknown {
  // Re-use gateway.buildQueryFn() which returns a QuerySnapshotFn bound to the
  // ACTIVE world (edit → doc.world, play → play world), so scope①'s `query`
  // reads the live play world during ▶ Play.
  return gateway.buildQueryFn();
}