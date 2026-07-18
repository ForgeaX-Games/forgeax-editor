// Aegis V2 — front-end observability reporting to the Galileo platform: JS /
// Promise / resource errors, page performance, Web Vitals, static-resource
// speed, PV+SPA route tracking, session timeline, and API monitoring with
// `traceparent` injection for front↔back trace linking. Auto-instrumenting:
// once `new Aegis(...)` runs it hooks window.onerror + unhandledrejection and
// rewrites XHR/fetch itself; no per-call-site instrumentation.
//
// MIRROR SAFETY (load-bearing): this package has a public open-source mirror
// whose publish pipeline scrubs + gates on internal hostnames. So NOTHING about
// the SDK is hardcoded here — the CDN url, report endpoint, and project token
// all arrive via build-time `import.meta.env.VITE_AEGIS_*`. With those unset
// (the open-source / default case) every export below is an inert no-op and no
// internal infra leaks into the committed source or the shipped bundle.
//
// Configure by dropping the three values into a gitignored `.env.local`; real
// endpoint values live in the internal setup note, not in any committed file.
// See `.env.example` for the (placeholder) shape.

/** Minimal surface of the Aegis instance we actually call. */
interface AegisInstance {
  error(payload: unknown): void;
  info(payload: unknown): void;
  report(payload: unknown): void;
  setConfig(config: Record<string, unknown>): void;
  destroy(): void;
}

type AegisCtor = new (config: Record<string, unknown>) => AegisInstance;

// The CDN bundle assigns the constructor to `window.Aegis`. We also stash our
// live instance on `window.__forgeaxAegis` so detached surface windows and the
// devtools bridge can reach the same instance.
declare global {
  interface Window {
    Aegis?: AegisCtor;
    __forgeaxAegis?: AegisInstance;
  }
}

let instance: AegisInstance | null = null;
let started = false;

/**
 * Boot Aegis if — and only if — a project token is configured AND this is a
 * production build. dev (`bun dev`) deliberately stays silent to keep the
 * Galileo dataset clean; verify the wiring with `bun run build && bun run
 * preview` (preview is a PROD build) or in the deployed web / desktop .app.
 *
 * Idempotent: StrictMode double-invokes and the two boot paths in main.tsx
 * (detached surface + full shell) can both call this; the `started` latch makes
 * the second call a no-op.
 */
export function initAegis(): void {
  if (started) return;
  started = true;

  // Unconditional entry beacon (warn-level so it survives DevTools log filters):
  // if you see NOTHING after restart + hard refresh, the new bundle isn't
  // loaded. The flags tell you which gate (below) stops reporting.
  console.warn('[aegis] initAegis() called', {
    PROD: import.meta.env.PROD,
    DEV: import.meta.env.DEV,
    VITE_AEGIS_DEV: import.meta.env.VITE_AEGIS_DEV,
    hasId: !!import.meta.env.VITE_AEGIS_ID,
    hasSdkUrl: !!import.meta.env.VITE_AEGIS_SDK_URL,
    hasHostUrl: !!import.meta.env.VITE_AEGIS_HOST_URL,
  });

  // Gate: production builds only — dev (`bun dev`) stays silent to keep the
  // dataset clean. Escape hatch for local verification: set VITE_AEGIS_DEV=1 in
  // .env.local to also report in dev (use VITE_AEGIS_ENV=test there so the
  // probe data lands in the test environment, not prod).
  const devForce = import.meta.env.VITE_AEGIS_DEV === '1' || import.meta.env.VITE_AEGIS_DEV === 'true';
  if (!import.meta.env.PROD && !devForce) {
    console.info('[aegis] inert: dev build — set VITE_AEGIS_DEV=1 in .env.development/.env.local and RESTART the dev server');
    return;
  }
  const id = import.meta.env.VITE_AEGIS_ID;
  const sdkUrl = import.meta.env.VITE_AEGIS_SDK_URL;
  const hostUrl = import.meta.env.VITE_AEGIS_HOST_URL;
  if (!id || !sdkUrl || !hostUrl) {
    console.warn('[aegis] inert: missing env (RESTART dev after editing .env*) —', {
      id: !!id,
      sdkUrl: !!sdkUrl,
      hostUrl: !!hostUrl,
    });
    return; // unconfigured → stay inert
  }

  console.info('[aegis] loading SDK:', sdkUrl);
  const script = document.createElement('script');
  script.src = sdkUrl;
  script.async = true;
  // crossorigin lets the SDK read full stack traces from cross-origin scripts;
  // without it window.onerror only sees "Script error." for foreign sources.
  script.crossOrigin = 'anonymous';
  script.onload = () => {
    const Aegis = window.Aegis;
    if (!Aegis) {
      console.warn('[aegis] SDK script loaded but window.Aegis missing');
      return;
    }
    try {
      // URLs to inject the `traceparent` header into, for session front↔back
      // trace linking. forgeax calls its backend same-origin (`/api`, `/ws`),
      // and same-origin requests skip CORS preflight, so injecting there is
      // safe. Override via VITE_AEGIS_TRACE_URLS (comma-separated regex source).
      const traceUrlsEnv = import.meta.env.VITE_AEGIS_TRACE_URLS;
      const injectTraceUrls = traceUrlsEnv
        ? traceUrlsEnv.split(',').map((s: string) => new RegExp(s.trim()))
        : [/\/api\//, /\/ws/];

      instance = new Aegis({
        id,
        hostUrl: { url: hostUrl },
        // 'production' → Galileo prod environment; anything else (test/personal)
        // routes to the test environment. Defaults to production.
        env: import.meta.env.VITE_AEGIS_ENV || 'production',
        // Aggregation: everything enqueued within `delay` ms is merged into ONE
        // /collect request. Aegis defaults to 1000ms which, on a chatty app
        // (continuous /api polling via the api plugin + console bridge), fires a
        // request almost every second. Widen the window to batch far more per
        // request. Override via VITE_AEGIS_DELAY (ms). compress gzips the body
        // (needs SDK >= 2.5.50) to cut bandwidth/cost on the bigger batches.
        delay: Number(import.meta.env.VITE_AEGIS_DELAY) || 5000,
        compress: true,
        plugin: {
          // Identity / context collectors.
          aid: true,
          device: true,
          close: true,
          fId: false, // fingerprint — hurts perf, off unless needed
          ie: false,
          // Page-view + SPA route-change tracking.
          pv: true,
          spa: true,
          // Error capture (JS / Promise / resource).
          error: true,
          // Static-resource speed + page performance + Web Vitals.
          assetSpeed: true,
          pagePerformance: true,
          webVitals: true,
          // Session replay-style timeline; requires the Galileo collect host.
          session: true,
          // API monitoring (rewrites XHR/fetch) WITH trace-header injection for
          // front↔back session linking. apiDetail left off so request/response
          // bodies are NOT collected (lighter + privacy-safer).
          api: {
            injectTraceHeader: 'traceparent',
            injectTraceUrls,
          },
          reporting: false,
        },
      });
      window.__forgeaxAegis = instance;
      console.info('[aegis] initialized → reporting to', hostUrl, '(env:', import.meta.env.VITE_AEGIS_ENV || 'production', ')');
      installConsoleBridge(instance);
    } catch (err) {
      console.warn('[aegis] init failed:', (err as Error)?.message ?? err);
    }
  };
  script.onerror = () => {
    console.warn('[aegis] SDK script failed to load:', sdkUrl);
  };
  document.head.appendChild(script);
}

/** Format one console arg into a loggable string (Errors keep their stack). */
function fmtConsoleArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a); // circular / non-serializable
  }
}

let consoleBridged = false;

/**
 * Mirror browser `console.*` output into Galileo as logs, so the platform's log
 * view shows runtime console output (not just auto-captured errors/perf). The
 * original console still prints to DevTools — we wrap, not replace.
 *
 * Which levels forward is controlled by VITE_AEGIS_CONSOLE_LEVELS (comma-sep,
 * default all: log,info,warn,error,debug; set "off" to disable, or e.g.
 * "warn,error" to cut volume). console.error → aegis.error; the rest →
 * aegis.info tagged with the original level.
 *
 * Volume note: forwarding ALL console output is high-traffic (engine/React spam)
 * and bills against Galileo — narrow the levels if it gets noisy.
 */
function installConsoleBridge(aegis: AegisInstance): void {
  if (consoleBridged) return; // idempotent (StrictMode / re-init guards)
  const cfg = (import.meta.env.VITE_AEGIS_CONSOLE_LEVELS ?? 'log,info,warn,error,debug').trim();
  if (cfg === 'off' || cfg === '') return;
  consoleBridged = true;

  const wanted = new Set(cfg.split(',').map((s: string) => s.trim()).filter(Boolean));
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const c = console as unknown as Record<string, (...args: unknown[]) => void>;
  let reentrant = false; // Aegis may itself console.* on send failure — don't loop

  for (const m of methods) {
    if (!wanted.has(m)) continue;
    const original = c[m].bind(console);
    c[m] = (...args: unknown[]) => {
      original(...args); // always keep DevTools output intact
      if (reentrant) return;
      try {
        const msg = args.map(fmtConsoleArg).join(' ');
        if (!msg || msg.startsWith('[aegis]')) return; // skip our own diagnostics
        reentrant = true;
        if (m === 'error') aegis.error({ msg, from: 'console' });
        else aegis.info({ msg, from: 'console', consoleLevel: m });
      } catch {
        /* never let logging crash the app */
      } finally {
        reentrant = false;
      }
    };
  }
}

/**
 * Report a React-render error. React error boundaries swallow render throws
 * before they reach window.onerror, so Aegis' auto JS-error capture never sees
 * them — this bridges that gap. No-op until the SDK instance is live (early
 * pre-load boundary catches are rare and still surface in the console).
 */
export function reportError(error: Error, componentStack?: string | null, scope?: string): void {
  if (!instance) return;
  try {
    instance.error({
      msg: `[${scope ?? 'react'}] ${error.message}`,
      stack: error.stack ?? '',
      componentStack: componentStack ?? '',
    });
  } catch {
    /* never let telemetry crash the error path */
  }
}

/**
 * Attach the current user's id once known. uid is often not available at boot,
 * so call this after auth/session resolves; Aegis backfills it on every
 * subsequent report. No-op until the SDK instance is live.
 */
export function setAegisUid(uid: string): void {
  if (!instance || !uid) return;
  try {
    instance.setConfig({ uid });
  } catch {
    /* no-op */
  }
}
