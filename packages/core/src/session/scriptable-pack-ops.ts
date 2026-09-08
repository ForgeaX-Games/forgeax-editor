import { SOURCE_AUTHORING_OPERATION_DESCRIPTORS } from "@forgeax/engine-pack/source";
import { listOps } from "../io/catalog";
import type { CommandError, EditorOp } from "../types";

export const GENERATED_SCENE_RECOVERY_ACTIONS = Object.freeze([
	"revealInFileManager",
	"promoteImportedScene",
	"asset-source.clone",
] as const);

export const SCRIPTABLE_PACK_RECOVERY_ACTIONS = Object.freeze([
	"continue-last-known-good",
	"retry-rebuild",
	"fresh-reopen",
	...GENERATED_SCENE_RECOVERY_ACTIONS,
] as const);

export type ScriptablePackRecoveryAction =
	(typeof SCRIPTABLE_PACK_RECOVERY_ACTIONS)[number];

export interface ScriptablePackRecoveryInput {
	readonly sourcePath: string;
	readonly failedRequestId: string;
	readonly requestId: string;
	readonly outputGuid?: string;
	readonly sourceKey?: string;
	readonly expectedRevision?: string;
	readonly phase?: string;
	readonly retryable?: boolean;
	readonly recoveryActions?: readonly string[];
	readonly action?: ScriptablePackRecoveryAction;
}

export interface ScriptablePackRecoveryPlan {
	readonly action: ScriptablePackRecoveryAction;
	readonly sourcePath: string;
	readonly failedRequestId: string;
	readonly requestId: string;
	readonly operation?: EditorOp;
	readonly reason: string;
}

export type GeneratedSceneOperationTarget =
	| "source"
	| "structure"
	| "output-reference"
	| "ordinary"
	| "wrapper"
	| "member-field";

export interface GeneratedSceneOperationInput {
	readonly kind: string;
	readonly target: GeneratedSceneOperationTarget;
	readonly sourcePath?: string;
	readonly sourceKey?: string;
	readonly outputGuid?: string;
	readonly expectedRevision?: string;
	readonly candidateGeneration?: number;
}

export interface GeneratedSceneReadOnlyError extends CommandError {
	readonly code: "generated-scene-read-only";
	readonly phase: "validation";
	readonly sourcePath?: string;
	readonly sourceKey?: string;
	readonly outputGuid?: string;
	readonly candidateGeneration?: number;
	readonly retryable: false;
	readonly recoveryActions: typeof GENERATED_SCENE_RECOVERY_ACTIONS;
}

export type GeneratedSceneOperationValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: GeneratedSceneReadOnlyError };

const GENERATED_SCENE_MUTATING_KINDS = new Set([
	"spawnEntity",
	"destroyEntity",
	"rename",
	"reparent",
	"hierarchyGesture",
	"setComponent",
	"addComponent",
	"removeComponent",
	"setVisibility",
	"removeSceneOverride",
	"setSceneSource",
	"replaceSceneOutput",
]);

/** Validate the generated Scene boundary before a Gateway applier mutates. */
export function validateGeneratedSceneOperation(
	input: GeneratedSceneOperationInput,
): GeneratedSceneOperationValidation {
	const readOnlyTarget =
		input.target === "source" ||
		input.target === "structure" ||
		input.target === "output-reference";
	if (!readOnlyTarget || !GENERATED_SCENE_MUTATING_KINDS.has(input.kind)) {
		return { ok: true };
	}
	return {
		ok: false,
		error: {
			code: "generated-scene-read-only",
			hint: "Generated Scene structure and output references are producer-owned and cannot be edited in place.",
			phase: "validation",
			...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
			...(input.sourceKey === undefined ? {} : { sourceKey: input.sourceKey }),
			...(input.outputGuid === undefined ? {} : { outputGuid: input.outputGuid }),
			...(input.expectedRevision === undefined
				? {}
				: { expectedRevision: input.expectedRevision }),
			...(input.candidateGeneration === undefined
				? {}
				: { candidateGeneration: input.candidateGeneration }),
			retryable: false,
			recoveryActions: GENERATED_SCENE_RECOVERY_ACTIONS,
		},
	};
}

export interface GeneratedSceneOperationManifestEntry {
	readonly id: string;
	readonly domain: "document" | "session" | "transient";
	readonly readOnly: boolean;
	readonly title: string;
	readonly terminal: readonly ["succeeded", "failed", "cancelled"];
}

export interface SourceAuthoringOperationManifestEntry {
	readonly id: string;
	readonly domain: "session" | "transient";
	readonly title: string;
	readonly argsSchema: unknown;
	readonly terminal: readonly ["succeeded", "failed", "cancelled"];
	readonly readModelFields: readonly string[];
}

/** Project Engine-owned source operations into the Editor read surface. */
export function sourceAuthoringOperationManifest(): readonly SourceAuthoringOperationManifestEntry[] {
	const preflight = listOps().find((descriptor) => descriptor.id === "asset.preflight");
	const preflightEntry: readonly SourceAuthoringOperationManifestEntry[] = preflight === undefined
		? []
		: [{
				id: preflight.id,
				domain: "transient",
				title: preflight.title ?? "Read Asset Source Preflight",
				argsSchema: preflight.argsSchema,
				terminal: ["succeeded", "failed", "cancelled"] as const,
				readModelFields: ["sourcePath", "sourceRevision", "impact", "recoveryActions"],
			}];
	return Object.freeze(
		[...preflightEntry, ...SOURCE_AUTHORING_OPERATION_DESCRIPTORS].map((descriptor) =>
			Object.freeze({
				id: descriptor.id,
				domain: descriptor.domain,
				title: descriptor.title,
				argsSchema: descriptor.argsSchema,
				terminal: ["succeeded", "failed", "cancelled"] as const,
				readModelFields: [
					"sourcePath",
					"sourceRevision",
					"generation",
					"digest",
					"outputSetDigest",
					"receipt",
					"current",
					"lastKnownGood",
					"diagnostics",
					"recoveryActions",
				],
			}),
		),
	);
}

/** Project source and ordinary Scene operations into one read surface. */
export function generatedSceneOperationManifest(): readonly GeneratedSceneOperationManifestEntry[] {
	const source = sourceAuthoringOperationManifest().map((entry) => ({
		id: entry.id,
		domain: entry.domain,
		readOnly: entry.domain === "transient",
		title: entry.title,
		terminal: entry.terminal,
	}));
	const ordinary: GeneratedSceneOperationManifestEntry[] = [
		{
			id: "addSceneAssetToScene",
			domain: "session",
			readOnly: false,
			title: "Add Scene Asset to Scene",
			terminal: ["succeeded", "failed", "cancelled"],
		},
		{
			id: "setDefaultScene",
			domain: "session",
			readOnly: false,
			title: "Set Default Scene",
			terminal: ["succeeded", "failed", "cancelled"],
		},
		{
			id: "setSceneOverride",
			domain: "document",
			readOnly: false,
			title: "Set Scene Instance Override",
			terminal: ["succeeded", "failed", "cancelled"],
		},
		{
			id: "saveDocToDisk",
			domain: "session",
			readOnly: false,
			title: "Save Document",
			terminal: ["succeeded", "failed", "cancelled"],
		},
		{
			id: "play",
			domain: "session",
			readOnly: false,
			title: "Play",
			terminal: ["succeeded", "failed", "cancelled"],
		},
	];
	return Object.freeze([...source, ...ordinary].map((entry) => Object.freeze(entry)));
}

function sourcePreflightOperation(input: ScriptablePackRecoveryInput): EditorOp | undefined {
	if (input.outputGuid === undefined) return undefined;
	return {
		kind: "asset.preflight",
		guid: input.outputGuid,
		scope: input.sourceKey === undefined ? { all: true } : { sourceKey: input.sourceKey },
		requestId: input.requestId,
	};
}

/** Plan recovery as a generic Gateway operation; this function performs no IO. */
export function planScriptablePackRecovery(
	input: ScriptablePackRecoveryInput,
): ScriptablePackRecoveryPlan {
	if (input.requestId === input.failedRequestId) {
		throw new Error("recovery requestId must be new and distinct from the failed request");
	}
	const advertised = input.recoveryActions?.find(
		(action): action is ScriptablePackRecoveryAction =>
			(SCRIPTABLE_PACK_RECOVERY_ACTIONS as readonly string[]).includes(action),
	);
	const action =
		input.action ??
		advertised ??
		(input.retryable === false || input.expectedRevision === undefined
			? "fresh-reopen"
			: "retry-rebuild");
	if (action === "retry-rebuild") {
		if (input.expectedRevision === undefined) {
			return {
				action,
				sourcePath: input.sourcePath,
				failedRequestId: input.failedRequestId,
				requestId: input.requestId,
				reason: "A rebuild retry requires the last complete source revision.",
			};
		}
		return {
			action,
			sourcePath: input.sourcePath,
			failedRequestId: input.failedRequestId,
			requestId: input.requestId,
			reason: "Retry the producer through the existing asset authoring Gateway operation.",
			operation: {
				kind: "asset-source.rebuild",
				sourcePath: input.sourcePath,
				expectedRevision: input.expectedRevision,
				requestId: input.requestId,
			},
		};
	}
	if (action === "continue-last-known-good" || action === "fresh-reopen") {
		const operation = sourcePreflightOperation(input);
		return {
			action,
			sourcePath: input.sourcePath,
			failedRequestId: input.failedRequestId,
			requestId: input.requestId,
			reason:
				action === "continue-last-known-good"
					? "Keep the last complete generation and avoid a partial refresh."
					: "Revalidate the source before the host performs a fresh reopen.",
			...(operation === undefined ? {} : { operation }),
		};
	}
	return {
		action,
		sourcePath: input.sourcePath,
		failedRequestId: input.failedRequestId,
		requestId: input.requestId,
		reason:
			action === "promoteImportedScene"
			? "Promotion remains an explicit authored decision after the failed generation is inspected."
			: action === "asset-source.clone"
				? "Fork remains an explicit authored decision after the failed generation is inspected."
				: "Reveal the producer source before choosing an authored recovery action.",
	};
}

export function recoveryActionsForScriptablePackError(
	error: Pick<CommandError, "recoveryActions" | "retryable" | "phase">,
): readonly string[] {
	const advertised =
		error.recoveryActions?.filter(
			(action): action is string => typeof action === "string",
		) ?? [];
	if (advertised.length > 0) return Object.freeze([...advertised]);
	return error.retryable === false
		? Object.freeze(["fresh-reopen"] as const)
		: error.phase === ("instantiate" as CommandError["phase"])
			? Object.freeze([
						"continue-last-known-good",
						"retry-rebuild",
						"fresh-reopen",
					] as const)
			: Object.freeze(["catalog.reconcile", "asset-source.rebuild", "reopen-scene"] as const);
}
