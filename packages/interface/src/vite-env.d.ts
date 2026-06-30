/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Monitoring project token (from the observability platform). Unset → inert. */
  readonly VITE_AEGIS_ID?: string;
  /** Aegis V2 SDK CDN url (e.g. the versioned aegis.min.js). */
  readonly VITE_AEGIS_SDK_URL?: string;
  /** Galileo collect endpoint the SDK reports to. */
  readonly VITE_AEGIS_HOST_URL?: string;
  /** 'production' (default) reports to Galileo prod; test/personal → test env. */
  readonly VITE_AEGIS_ENV?: string;
  /** Comma-separated regex sources for URLs to inject `traceparent` into.
   *  Defaults to same-origin /api + /ws. */
  readonly VITE_AEGIS_TRACE_URLS?: string;
  /** '1'/'true' → also report in dev builds (off by default). For verification. */
  readonly VITE_AEGIS_DEV?: string;
  /** Console levels to mirror into Galileo (comma-sep). Default all
   *  (log,info,warn,error,debug); "off" disables; e.g. "warn,error". */
  readonly VITE_AEGIS_CONSOLE_LEVELS?: string;
  /** Report aggregation window in ms — reports within it merge into one
   *  request. Default 5000 (Aegis SDK default is 1000). */
  readonly VITE_AEGIS_DELAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
