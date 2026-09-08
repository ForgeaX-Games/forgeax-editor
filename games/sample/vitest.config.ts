import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const sampleDir = dirname(fileURLToPath(import.meta.url));
const enginePackagesDir = pathResolve(sampleDir, "../../packages/engine/packages");

function pinnedEngineSource(): Plugin {
	const packageSources = new Map<string, string>();
	for (const packageDir of readdirSync(enginePackagesDir, { withFileTypes: true })) {
		if (!packageDir.isDirectory()) continue;
		const packageJsonPath = pathResolve(enginePackagesDir, packageDir.name, "package.json");
		try {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
			if (typeof packageJson.name === "string") {
				packageSources.set(packageJson.name, pathResolve(enginePackagesDir, packageDir.name, "src"));
			}
		} catch {
			// Non-package directories are not importable engine workspaces.
		}
	}
	return {
		name: "forgeax-sample-pinned-engine-source",
		enforce: "pre",
		resolveId(source) {
			if (!source.startsWith("@forgeax/engine-")) return null;
			const match = /^(?<packageName>@forgeax\/engine-[^/]+)(?:\/(?<subpath>.*))?$/.exec(source);
			if (match === null) return null;
			const packageName = match.groups?.packageName ?? source;
			const sourceRoot = packageSources.get(packageName);
			if (sourceRoot === undefined) {
				throw new Error(`Sample test imported an unpinned Engine package: ${source}`);
			}
			const subpath = match.groups?.subpath ?? "";
			if (packageName === "@forgeax/engine-render" && subpath === "internal") {
				return pathResolve(sourceRoot, "internal.ts");
			}
			if (packageName === "@forgeax/engine-render" && subpath.startsWith("internal/")) {
				return `${pathResolve(sourceRoot, subpath.slice("internal/".length))}.ts`;
			}
			const entry = packageName === "@forgeax/engine-pack" && subpath === "name"
				? "deriveAssetName.ts"
				: packageName === "@forgeax/engine-pack" && subpath === "resolve"
					? "resolve-asset-source.ts"
					: subpath === "guid"
				? "guid.ts"
				: subpath === "source"
					? "scriptable-pack.ts"
					: subpath === "externalization"
						? "externalization/index.ts"
					: subpath === ""
						? "index.ts"
						: undefined;
			const sourceEntry = entry ?? subpath.replace(/\.(?:m?js|ts|tsx)$/, "");
			const sourceFile = pathResolve(sourceRoot, sourceEntry);
			const sourceIndex = pathResolve(sourceRoot, sourceEntry, "index.ts");
			if (entry === undefined && !existsSync(`${sourceFile}.ts`) && !existsSync(sourceIndex)) {
				throw new Error(`Sample test imported an unpinned Engine subpath: ${source}`);
			}
			return entry === undefined
				? (existsSync(`${sourceFile}.ts`) ? `${sourceFile}.ts` : sourceIndex)
				: sourceFile;
		},
	};
}

export default defineConfig({
	plugins: [pinnedEngineSource()],
	test: {
		name: "@forgeax/game-sample",
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
	},
});
