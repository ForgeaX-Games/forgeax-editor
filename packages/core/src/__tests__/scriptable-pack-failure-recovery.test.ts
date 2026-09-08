import { describe, expect, it } from "bun:test";
import { createGeneratedSceneRefreshOwner } from "../scene/generated-scene-refresh";
import {
	planScriptablePackRecovery,
	recoveryActionsForScriptablePackError,
} from "../session/scriptable-pack-ops";

const request = {
	wrapper: 7 as never,
	sourcePath: "assets/showcase.pack.ts",
	sourceKey: "scene/showcase",
	generation: 4,
	overrides: [],
};

describe("ScriptablePack failure recovery", () => {
	it("keeps the authored wrapper and previous derived tree when staging fails", async () => {
		let swapped = false;
		let discarded = false;
		const owner = createGeneratedSceneRefreshOwner({
			snapshotWrapper: () => ({
				root: 7 as never,
				parent: null,
				transform: { pos: [1, 2, 3] },
				sourcePath: request.sourcePath,
				sourceKey: request.sourceKey,
				generation: 3,
			}),
			stageTree: async () => ({
				ok: false,
				error: { code: "catalog-gap", generation: 4 },
			}),
			swapTree: () => {
				swapped = true;
				return { ok: true };
			},
			discardTree: () => {
				discarded = true;
			},
		});

		await expect(owner.refresh(request)).resolves.toMatchObject({
			ok: false,
			error: {
				code: "generated-scene-refresh-failed",
				phase: "publication",
				sourcePath: request.sourcePath,
				candidateGeneration: 4,
				currentGeneration: 3,
				retryable: true,
				recoveryActions: [
					"asset-source.rebuild",
					"asset.preflight",
					"reopen-scene",
				],
			},
		});
		expect(swapped).toBe(false);
		expect(discarded).toBe(false);
	});

	it("rejects stale overrides without touching the active tree", async () => {
		let swapped = false;
		const owner = createGeneratedSceneRefreshOwner({
			snapshotWrapper: () => ({
				root: 7 as never,
				parent: null,
				transform: {},
				sourcePath: request.sourcePath,
				sourceKey: request.sourceKey,
				generation: 3,
			}),
			stageTree: async () => ({
				ok: true,
				value: {
					token: "candidate",
					members: [8 as never],
					state: { members: new Set([8 as never]), fields: new Set() },
				},
			}),
			swapTree: () => {
				swapped = true;
				return { ok: true };
			},
		});
		await expect(
			owner.refresh({
				...request,
				overrides: [
					{
						member: 8 as never,
						component: "Transform",
						field: "pos",
						value: [1, 2, 3],
					},
				],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "generated-scene-stale-override" },
		});
		expect(swapped).toBe(false);
	});

	it("plans Human and AI recovery through the same Gateway operation shape", () => {
		const human = planScriptablePackRecovery({
			sourcePath: request.sourcePath,
			failedRequestId: "failed-4",
			requestId: "retry-5",
			expectedRevision: "revision-3",
			retryable: true,
			action: "retry-rebuild",
		});
		const ai = planScriptablePackRecovery({
			sourcePath: request.sourcePath,
			failedRequestId: "failed-4",
			requestId: "retry-5",
			expectedRevision: "revision-3",
			retryable: true,
			action: "retry-rebuild",
		});
		expect(human).toEqual(ai);
		expect(human.operation).toEqual({
			kind: "asset-source.rebuild",
			sourcePath: request.sourcePath,
			expectedRevision: "revision-3",
			requestId: "retry-5",
		});
		expect(
			recoveryActionsForScriptablePackError({
				retryable: true,
				phase: "instantiate" as never,
			}),
		).toEqual(["continue-last-known-good", "retry-rebuild", "fresh-reopen"]);
		expect(
			planScriptablePackRecovery({
				sourcePath: request.sourcePath,
				failedRequestId: "failed-4",
				requestId: "fresh-5",
				outputGuid: "scene-output",
				action: "fresh-reopen",
			}).operation,
		).toMatchObject({ kind: "asset.preflight", guid: "scene-output", scope: { all: true } });
	});
});
