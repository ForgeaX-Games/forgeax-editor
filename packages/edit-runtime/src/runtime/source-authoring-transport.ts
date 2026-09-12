import {
	assetIO,
	broadcastAssetsChanged,
	type CommandError,
	createAuthoredAssetCatalogBarrier,
	refreshGeneratedSceneInstances,
	type EditorOp,
	gateway,
	type SourceAuthoringOperationDescriptor,
	type SourceAuthoringRuntimeResult,
} from "@forgeax/editor-core";
import { SOURCE_AUTHORING_OPERATION_DESCRIPTORS } from "@forgeax/engine-pack/source";
import type { SourceAuthoringProducerPreflight } from "./source-authoring-runtime";

interface SourceAuthoringOperationResult {
	readonly sourcePath: string;
	readonly revision: string;
	readonly meta: unknown;
	readonly capabilities?: unknown;
	readonly incomingRefs?: readonly string[];
	readonly sourceCommitted?: boolean;
	readonly catalogObserved?: boolean;
	/** Captured before the request so the barrier cannot accept the old row. */
	readonly previousCatalogRevision?: string;
	/** Captured before the request so rebuilds cannot accept the old publication tuple. */
	readonly previousPublication?: Partial<{
		readonly generation: number;
		readonly digest: string;
		readonly outputSetDigest: string;
		readonly packageUrl: string;
		readonly receiptKey: string;
	}>;
}

export interface SourceAuthoringTransportDependencies {
	/** Captured viewport identity; never follow a mutable host active-game value. */
	readonly gameId?: string;
	readonly scopeId?: string;
	readonly generation?: number;
	readonly endpoint?: string;
	readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
	readonly triggerCook?: (
		guid: string,
		mode?: "rebuild" | "cold-cook",
	) => ReturnType<typeof assetIO.triggerCook>;
	readonly observePublication: (
		result: SourceAuthoringOperationResult,
		operation: EditorOp,
	) => Promise<void>;
}

const engineKindByEditorKind: Readonly<Record<string, string>> = {
	"asset-source.create": "create-scriptable-pack",
	"asset-source.add-output": "add-output",
	"asset-source.add-external-asset": "add-external-asset",
	"asset-source.rename": "rename-display",
	"asset-source.remove-output": "remove-output",
	"asset-source.clone": "clone-scriptable-pack",
	"asset-source.rebuild": "rebuild",
	"asset-source.cold-cook": "cold-cook",
};

function transportError(hint: string): SourceAuthoringRuntimeResult {
	return {
		ok: false,
		error: {
			code: "operation-failed",
			hint,
			owner: "transport",
			category: "transport",
			retryable: true,
			recoveryActions: ["run.retry", "asset.preflight"],
		},
	};
}

function requestIdOf(operation: EditorOp): string | undefined {
	const requestId = (operation as { readonly requestId?: unknown }).requestId;
	return typeof requestId === "string" ? requestId : undefined;
}

function normalizeError(error: unknown, operation: EditorOp): CommandError {
	const value =
		error !== null && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	return {
		code: (typeof value.code === "string"
			? value.code
			: "operation-failed") as CommandError["code"],
		hint:
			typeof value.hint === "string"
				? value.hint
				: "Structured source authoring operation failed.",
		owner: "engine",
		category:
			typeof value.code === "string" && value.code.includes("revision")
				? "state"
				: "resource",
		operationId: operation.kind,
		...(requestIdOf(operation) === undefined
			? {}
			: { requestId: requestIdOf(operation) }),
		retryable: value.retryable === true,
		recoveryActions: Array.isArray(value.recoveryActions)
			? value.recoveryActions.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: ["asset.preflight"],
		...(value.expected === undefined ? {} : { expected: value.expected }),
		...(value.actual === undefined ? {} : { actual: value.actual }),
		details: value.detail ?? value.details,
	};
}

function producerPreflightError(error: CommandError): Error {
	const value = new Error(error.hint) as Error & {
		readonly code?: string;
		readonly retryable?: boolean;
		readonly recoveryActions?: readonly string[];
	};
	Object.defineProperties(value, {
		code: { value: error.code },
		retryable: { value: error.retryable },
		recoveryActions: { value: error.recoveryActions },
	});
	return value;
}

function parseProducerPreflight(value: unknown): SourceAuthoringProducerPreflight {
	if (value === null || typeof value !== "object") {
		throw new Error("Source authoring producer returned no preflight value.");
	}
	const result = value as Record<string, unknown>;
	if (
		typeof result.sourcePath !== "string" ||
		typeof result.revision !== "string" ||
		!Object.hasOwn(result, "meta")
	) {
		throw new Error("Source authoring producer returned an incomplete preflight value.");
	}
	return {
		sourcePath: result.sourcePath,
		revision: result.revision,
		meta: result.meta,
	};
}

function outputGuids(meta: unknown): readonly string[] {
	if (meta === null || typeof meta !== "object") return [];
	const subAssets = (meta as { readonly subAssets?: unknown }).subAssets;
	if (!Array.isArray(subAssets)) return [];
	return subAssets.flatMap((entry) => {
		if (entry === null || typeof entry !== "object") return [];
		const guid = (entry as { readonly guid?: unknown }).guid;
		return typeof guid === "string" ? [guid] : [];
	});
}

function revisionText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return undefined;
	const digest = (value as { readonly digest?: unknown }).digest;
	return typeof digest === "string" ? digest : undefined;
}

function publicationFacts(
	value: unknown,
): SourceAuthoringOperationResult["previousPublication"] {
	if (value === null || typeof value !== "object") return undefined;
	const current = (value as { readonly current?: unknown }).current;
	if (current === null || typeof current !== "object") return undefined;
	const locator = current as Record<string, unknown>;
	return {
		...(typeof locator.generation === "number"
			? { generation: locator.generation }
			: {}),
		...(typeof locator.digest === "string" ? { digest: locator.digest } : {}),
		...(typeof locator.outputSetDigest === "string"
			? { outputSetDigest: locator.outputSetDigest }
			: {}),
		...(typeof locator.packageUrl === "string"
			? { packageUrl: locator.packageUrl }
			: {}),
		...(typeof locator.receiptKey === "string"
			? { receiptKey: locator.receiptKey }
			: {}),
	};
}

async function observePublication(
	result: SourceAuthoringOperationResult,
): Promise<void> {
	const registry = gateway.doc.registry;
	if (registry === undefined)
		throw new Error(
			"The live AssetRegistry is not available to observe asset-source publication.",
		);
	const barrier = createAuthoredAssetCatalogBarrier(registry);
	const guids = outputGuids(result.meta);
	if (guids.length === 0)
		throw new Error("Asset source Meta exposed no output GUIDs to observe.");
	for (const guid of guids) {
		await barrier(guid, {
			...(result.previousCatalogRevision === undefined
				? {}
				: { previousRevision: result.previousCatalogRevision }),
			...(result.previousPublication === undefined
				? {}
				: { previousPublication: result.previousPublication }),
			requireCurrentPublication: true,
		});
	}
	const outputGuidSet = new Set(guids.map((guid) => guid.toLowerCase()));
	const publication = registry
		.catalogSnapshot?.()
		?.entries
		.map((entry) => entry.publication)
		.find((candidate) => candidate !== undefined
			&& candidate.sourcePath === result.sourcePath
			&& candidate.sourceRevision === result.revision
			&& candidate.outputs.some((output) => outputGuidSet.has(output.guid.toLowerCase())));
	if (publication !== undefined) {
		await refreshGeneratedSceneInstances({
			sourcePath: publication.sourcePath,
			sourceRevision: publication.sourceRevision,
			generation: publication.generation,
			digest: publication.digest,
			outputSetDigest: publication.outputSetDigest,
			outputGuids: publication.outputs.map((output) => output.guid),
		});
	}
	broadcastAssetsChanged("pack-changed", "local-op");
}

export function createSourceAuthoringTransport(
	overrides: Partial<SourceAuthoringTransportDependencies> = {},
): {
	readonly operations: readonly SourceAuthoringOperationDescriptor[];
	readonly preflightSource: (input: {
		readonly sourcePath: string;
		readonly requestId: string;
	}) => Promise<SourceAuthoringProducerPreflight>;
	readonly execute: (
		operation: EditorOp,
	) => Promise<SourceAuthoringRuntimeResult>;
} {
	const deps: SourceAuthoringTransportDependencies = {
		fetch: (path, init) => fetch(path, init),
		triggerCook: (guid, mode) => assetIO.triggerCook(guid, undefined, mode),
		observePublication,
		...overrides,
	};
	const headers = {
		"content-type": "application/json",
		...(deps.gameId ? { "x-forgeax-game-id": deps.gameId } : {}),
		...(deps.scopeId ? { "x-forgeax-scope-id": deps.scopeId } : {}),
		...(deps.generation !== undefined ? { "x-forgeax-generation": String(deps.generation) } : {}),
	};
	const operations = SOURCE_AUTHORING_OPERATION_DESCRIPTORS.map(
		(descriptor) => ({
			id: descriptor.id,
			domain: descriptor.domain,
			title: descriptor.title,
			argsSchema: descriptor.argsSchema,
		}),
	);
	return {
		operations,
		async preflightSource({ sourcePath, requestId }) {
			const operation = { kind: "asset.preflight", sourcePath, requestId } as EditorOp;
			let response: Response;
			try {
				response = await deps.fetch(deps.endpoint ?? "/api/assets/source/execute", {
					method: "POST",
					headers,
					body: JSON.stringify({ kind: "preflight", sourcePath, requestId }),
				});
			} catch (error) {
				throw new Error(error instanceof Error ? error.message : String(error));
			}
			const body = (await response.json().catch(() => null)) as null | {
				readonly ok?: unknown;
				readonly value?: unknown;
				readonly error?: unknown;
			};
			if (!response.ok || body === null) {
				throw new Error(`Source authoring host returned HTTP ${response.status}.`);
			}
			if (body.ok !== true) {
				throw producerPreflightError(normalizeError(body.error, operation));
			}
			return parseProducerPreflight(body.value);
		},
		async execute(operation) {
			const editorKind = operation.kind as string;
			const descriptor = SOURCE_AUTHORING_OPERATION_DESCRIPTORS.find(
				(candidate) => candidate.id === editorKind,
			);
			if (descriptor === undefined) {
				return transportError(
					`Unsupported structured source operation: ${editorKind}.`,
				);
			}
			const { kind: _editorKind, ...args } = operation as Record<
				string,
				unknown
			>;
			const guid = typeof args.guid === "string" ? args.guid : undefined;
			const ownerGuid =
				typeof args.ownerGuid === "string"
					? args.ownerGuid
					: editorKind === "asset-source.add-external-asset"
						? undefined
						: guid;
			if (args.sourcePath === undefined && ownerGuid !== undefined) {
				const row = gateway
					.assetCatalog()
					.find(
						(candidate) =>
							candidate.guid.toLowerCase() === ownerGuid.toLowerCase(),
					);
				if (row?.sourcePath === undefined) {
					return transportError(
						`No Catalog source owner is available for GUID ${ownerGuid}.`,
					);
				}
				args.sourcePath = row.sourcePath;
			}
			const subjectRow = gateway
				.assetCatalog()
				.find(
					(candidate) =>
						(args.sourcePath !== undefined &&
							candidate.sourcePath === args.sourcePath) ||
						(ownerGuid !== undefined &&
							candidate.guid.toLowerCase() === ownerGuid.toLowerCase()),
				);
			const previousCatalogRevision = revisionText(subjectRow?.revision);
			const previousPublication = publicationFacts(
				(subjectRow as { readonly publication?: unknown } | undefined)
					?.publication,
			);
			const publicationOnly =
				editorKind === "asset-source.rebuild" ||
				editorKind === "asset-source.cold-cook";
			const cookMode =
				editorKind === "asset-source.cold-cook" ? "cold-cook" : "rebuild";
			let response: Response;
			try {
				response = await deps.fetch(deps.endpoint ?? "/api/assets/source/execute", {
					method: "POST",
					headers,
					body: JSON.stringify({
						...args,
						kind: engineKindByEditorKind[
							editorKind as keyof typeof engineKindByEditorKind
						],
					}),
				});
			} catch (error) {
				return transportError(
					error instanceof Error ? error.message : String(error),
				);
			}
			const body = (await response.json().catch(() => null)) as null | {
				readonly ok?: unknown;
				readonly value?: unknown;
				readonly error?: unknown;
			};
			if (!response.ok || body === null) {
				return transportError(
					`Source authoring host returned HTTP ${response.status}.`,
				);
			}
			if (
				body.ok === true &&
				body.value !== null &&
				typeof body.value === "object"
			) {
				const value = body.value as SourceAuthoringOperationResult;
				const cookGuid =
					subjectRow?.guid ?? ownerGuid ?? outputGuids(value.meta)[0];
				if (cookGuid === undefined) {
					return transportError(
						`Source operation ${editorKind} returned no owner GUID to cook.`,
					);
				}
				if (deps.triggerCook !== undefined) {
					const cooked = await deps.triggerCook(cookGuid, cookMode);
					if (!cooked.ok) {
						return transportError(cooked.error.hint);
					}
				}
				const observedValue = {
					...value,
					...(publicationOnly || previousCatalogRevision === undefined
						? {}
						: { previousCatalogRevision }),
					...(publicationOnly || previousPublication === undefined
						? {}
						: { previousPublication }),
				};
				try {
					await deps.observePublication(observedValue, operation);
				} catch (error) {
					return {
						ok: false,
						error: {
							code: "asset-publish-observation-timeout",
							hint: error instanceof Error ? error.message : String(error),
							owner: "engine",
							category: "state",
							operationId: operation.kind,
							...(requestIdOf(operation) === undefined
								? {}
								: { requestId: requestIdOf(operation) }),
							retryable: true,
							recoveryActions: ["catalog.reconcile", "run.retry"],
							details: {
								sourceCommitted: true,
								sourcePath: value.sourcePath,
								revision: value.revision,
							},
						},
					};
				}
				return {
					ok: true,
					value: {
						...observedValue,
						sourceCommitted: true,
						catalogObserved: true,
					},
				};
			}
			return { ok: false, error: normalizeError(body.error, operation) };
		},
	};
}
