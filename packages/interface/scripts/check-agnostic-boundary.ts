import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validateApiCall } from "./agnostic-api-policy";

const root = join(import.meta.dir, "..", "src");
const packageJsonPath = join(import.meta.dir, "..", "package.json");
const forbidden = new Set([
  "@forgeax/editor",
  "@forgeax/chat",
  "@forgeax/ai-workbench",
  "@forgeax/settings",
  "@forgeax/dashboard",
]);
// Aliases that were removed — importing them = using a stale name.
// Bump 3 renamed `@forgeax/workbench` → `@forgeax/ai-workbench`; any lingering
// reference to the old literal is caught here with a clearer error message than
// the generic forbidden-package rule above.
const removedAliases = new Set([
  "@forgeax/workbench",
]);
const forbiddenExports = [
  "./components/TopBar/SettingsDrawer",
  "./lib/event-engine/event-replay",
  "./lib/event-engine/message-builder",
  "./lib/event-engine/rewind-mask",
  "./lib/event-engine/turn-accumulator",
  "./lib/event-engine/types",
  "./lib/forgeax-bridge",
];

const importPattern =
  /\b(?:from\s*|import\s+(?:[^"'();]+?\s+from\s*)?|import\s*\(\s*)["'`](@forgeax\/[^"'`]+)["'`]/g;
const apiCallPattern =
  /\b(?:fetch|EventSource|navigator\.sendBeacon)\s*\(\s*(["'`])([^"'`]*\/api\/[^"'`]*)\1/g;

const sourceFiles: string[] = [];

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      walk(path);
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      sourceFiles.push(path);
    }
  }
}

walk(root);

const violations: string[] = [];

for (const file of sourceFiles) {
  const sourcePath = relative(process.cwd(), file);
  const source = stripComments(readFileSync(file, "utf8"));
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (removedAliases.has(specifier) || [...removedAliases].some((r) => specifier.startsWith(`${r}/`))) {
      violations.push(
        `${relative(process.cwd(), file)}: import of removed alias '${specifier}' — did you mean '@forgeax/ai-workbench'?`,
      );
    }
    for (const pkg of forbidden) {
      if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
        violations.push(`${relative(process.cwd(), file)} imports ${specifier}`);
      }
    }
  }
  for (const match of source.matchAll(apiCallPattern)) {
    const endpoint = match[2];
    const violation = validateApiCall(endpoint, sourcePath);
    if (violation) violations.push(`${sourcePath} ${violation}`);
  }
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  exports?: Record<string, unknown>;
};
for (const key of forbiddenExports) {
  if (packageJson.exports && key in packageJson.exports) {
    violations.push(`package.json exports forbidden legacy path ${key}`);
  }
}

if (violations.length > 0) {
  console.error("Interface boundary violations:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
