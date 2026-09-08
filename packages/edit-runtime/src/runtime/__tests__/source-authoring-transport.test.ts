import { describe, expect, test } from "bun:test";
import { createSourceAuthoringTransport } from "../source-authoring-transport";

const value = {
	sourcePath: "assets/showcase.pack.ts",
	revision: "a".repeat(64),
	meta: { subAssets: [{ guid: "11111111-1111-4111-8111-111111111111" }] },
};

describe("asset source authoring host seam", () => {
	test("reads producer preflight through the source host without cooking or publication observation", async () => {
		let request: Record<string, unknown> | undefined;
		const runtime = createSourceAuthoringTransport({
			fetch: async (_path, init) => {
				request = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return Response.json({ ok: true, value });
			},
		});

		await expect(runtime.preflightSource({
			sourcePath: value.sourcePath,
			requestId: "pack-preflight-1",
		})).resolves.toEqual(value);
		expect(request).toEqual({
			kind: "preflight",
			sourcePath: value.sourcePath,
			requestId: "pack-preflight-1",
		});
	});

	test("maps a producer capability through the generic source authoring transport and waits for publication", async () => {
		const events: string[] = [];
		const cookModes: string[] = [];
		const runtime = createSourceAuthoringTransport({
			triggerCook: async (_guid, mode) => {
				cookModes.push(mode ?? "rebuild");
				return { ok: true, value: undefined };
			},
			fetch: async (path, init) => {
				const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
				events.push(
					`fetch:${path}:${init?.method}:${input.kind}:${input.sourceKey}`,
				);
				expect(input).not.toHaveProperty("_editorKind");
				return Response.json({ ok: true, value });
			},
			observePublication: async (result, operation) => {
				events.push(`observe:${operation.kind}:${result.revision}`);
			},
		});

		await expect(
			runtime.execute({
				kind: "asset-source.add-output",
				sourcePath: value.sourcePath,
				sourceKey: "mesh:spire",
				assetKind: "mesh",
				name: "Spire",
				expectedRevision: "b".repeat(64),
				requestId: "script-pack-add-1",
			}),
		).resolves.toEqual({
			ok: true,
			value: { ...value, sourceCommitted: true, catalogObserved: true },
		});
		expect(events).toEqual([
			"fetch:/api/assets/source/execute:POST:add-output:mesh:spire",
			`observe:asset-source.add-output:${value.revision}`,
		]);
		expect(cookModes).toEqual(["rebuild"]);
	});

	test("returns a recovery-bearing partial-success error when source committed but publication is not observable", async () => {
		const runtime = createSourceAuthoringTransport({
			triggerCook: async () => ({ ok: true, value: undefined }),
			fetch: async () => Response.json({ ok: true, value }),
			observePublication: async () => {
				throw new Error("catalog row never became consumable");
			},
		});

		await expect(
			runtime.execute({
				kind: "asset-source.rebuild",
				sourcePath: value.sourcePath,
				expectedRevision: "b".repeat(64),
				requestId: "script-pack-observe-1",
			}),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: "asset-publish-observation-timeout",
				owner: "engine",
				retryable: true,
				recoveryActions: ["catalog.reconcile", "run.retry"],
				details: {
					sourceCommitted: true,
					sourcePath: value.sourcePath,
					revision: value.revision,
				},
			},
		});
	});

	test("preserves Engine revision conflicts without collapsing them to transport failures", async () => {
		const runtime = createSourceAuthoringTransport({
			fetch: async () =>
				Response.json({
					ok: false,
					error: {
						code: "pack-source-revision-conflict",
						hint: "Expected revision is stale.",
						retryable: true,
						recoveryActions: ["asset.preflight"],
						expected: "old",
						actual: "new",
						detail: { sourcePath: value.sourcePath },
					},
				}),
			observePublication: async () => undefined,
		});

		await expect(
			runtime.execute({
				kind: "asset-source.cold-cook",
				sourcePath: value.sourcePath,
				expectedRevision: "b".repeat(64),
				requestId: "script-pack-stale-1",
			}),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: "pack-source-revision-conflict",
				category: "state",
				operationId: "asset-source.cold-cook",
				requestId: "script-pack-stale-1",
				expected: "old",
				actual: "new",
				details: { sourcePath: value.sourcePath },
			},
		});
	});
});
