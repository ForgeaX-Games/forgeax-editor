export interface ApiCallRule {
  pattern: RegExp;
  source?: string;
}

export const allowedApiRules: ApiCallRule[] = [
  { pattern: /^\/api\/boot-splash$/ },
  { pattern: /^\/api\/extensions\/list(?:\?kind=(?:\$\{[^}]+\}|cli-provider))?$/ },
  { pattern: /^\/api\/extensions\/capabilities$/ },
  { pattern: /^\/api\/bus\/ui\/surfaces(?:\/\$\{[^}]+\}\/(?:ack|pending|snapshot)|\/\$\{[^}]+\})?$/ },
  { pattern: /^\/api\/cli\/health$/ },
  { pattern: /^\/api\/commands\/(?:\$\{[^}]+\}|upload)\/(?:execute|query)$/ },
  { pattern: /^\/api\/events\/stream\?topic=(?:plugin\.reloaded|tool\.confirm-\*|tool\.confirm-required)$/ },
  { pattern: /^\/api\/files\/tree\?root=.forgeax\/games\/\$\{[^}]+\}$/ },
  { pattern: /^\/api\/fs\/browse\?dir=\$\{[^}]+\}$/ },
  { pattern: /^\/api\/fs\/pick-directory$/ },
  {
    pattern: /^\/api\/game-host\/games\/\$\{[^}]+\}\/package\/(?:initialize|status)$/,
    source: "src/lib/game-host-api.ts",
  },
  { pattern: /^\/api\/health$/ },
  { pattern: /^\/api\/logs$/ },
  { pattern: /^\/api\/narrative\/history$/ },
  { pattern: /^\/api\/prefs\/(?:browser-localStorage|workbench-layout\/\$\{[^}]+\})$/ },
  { pattern: /^\/api\/projects$/ },
  { pattern: /^\/api\/projects\/(?:registered\?path=\$\{[^}]+\}|\$\{[^}]+\})$/ },
  { pattern: /^\/api\/sessions\/\$\{[^}]+\}(?:\/(?:abort\$\{[^}]+\}|checkpoints|file-activity\?limit=100|perception-reply|rewind(?:\/(?:cancel|overwrite-dirty|preview|undo-overwrite))?|ui-lease|ui-manifest))?$/ },
  { pattern: /^\/api\/settings(?:\/env)?$/ },
  { pattern: /^\/api\/telemetry$/ },
  { pattern: /^\/api\/threads\/\$\{[^}]+\}$/ },
  { pattern: /^\/api\/tools(?:\/call|\/confirm)?$/ },
  { pattern: /^\/api\/version(?:\/tags)?$/ },
  { pattern: /^\/api\/workbench\/games$/ },
  { pattern: /^\/api\/workbench\/games\/link$/ },
  { pattern: /^\/api\/workbench\/templates$/ },
  { pattern: /^\/api\/workbench\/package\/reveal$/ },
  { pattern: /^\/api\/workspaces\/activate$/ },
  { pattern: /^\/api\/workspaces\/active$/ },
];

export function validateApiCall(endpoint: string, source: string): string | null {
  const rule = allowedApiRules.find(({ pattern }) => pattern.test(endpoint));
  if (!rule) return `calls unallowlisted API endpoint ${endpoint}`;
  const normalizedSource = source.replaceAll("\\", "/");
  if (rule.source && rule.source !== normalizedSource) {
    return `calls ${endpoint}, which must be called from ${rule.source}`;
  }
  return null;
}
