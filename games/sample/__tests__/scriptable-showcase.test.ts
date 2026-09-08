import { readFile } from "node:fs/promises";
import { defineComponent, World } from "@forgeax/engine-ecs";
import {
	buildScriptablePack,
	createStandardAssetOutputProducerRegistry,
	type ScriptablePackAssetSnapshotSource,
} from "@forgeax/engine-import";
import { AssetGuid } from "@forgeax/engine-pack/guid";
import { serializeSceneAssetToPack } from "@forgeax/engine-runtime";
import type {
	Asset,
	AssetGuid as AssetGuidType,
	MeshAsset,
	SamplerAsset,
	SceneAsset,
	TextureAsset,
} from "@forgeax/engine-types";
import {
	AssetError,
	err,
	ok,
	type SceneInstanceMount,
} from "@forgeax/engine-types";
import { describe, expect, it } from "vitest";
import inputPack from "../assets/procedural-inputs.pack";
import showcasePack from "../assets/procedural-showcase.pack";
import { sceneMount } from "../assets/procedural-showcase.pack-lib";

defineComponent("Transform", {});
defineComponent("ChildOf", { parent: { type: "entity" } });
defineComponent("MeshFilter", { assetHandle: { type: "shared<MeshAsset>" } });
defineComponent("MeshRenderer", {
	materials: { type: "array<shared<MaterialAsset>>" },
});
defineComponent("ParticleEffectPlayer", {
	effect: { type: "shared<ParticleEffectAsset>" },
});
defineComponent("SceneInstance", {
	source: { type: "shared<SceneAsset>" },
	mapping: { type: "array<entity>" },
	state: { type: "unique<SceneInstanceState>" },
});

const TEMPLATE_GUID = "019ffdb4-0000-7000-8000-000000000001";
const ACCENT_GUID = "019ffdb4-0000-7000-8000-000000000002";

function guid(value: string): AssetGuidType {
	const parsed = AssetGuid.parse(value);
	if (!parsed.ok) throw parsed.error;
	return parsed.value;
}

async function source(
	missing: readonly string[] = [],
): Promise<ScriptablePackAssetSnapshotSource> {
	const inputs = await inputPack.build();
	if (!inputs.ok) throw inputs.error;
	const assets = new Map<string, Asset>([
		[TEMPLATE_GUID, inputs.value["mesh/template-shard"] as MeshAsset],
		[ACCENT_GUID, inputs.value["material/accent"]],
		[
			"019ffdb4-0000-7000-8000-000000000004",
			inputs.value["scene/crystal-cluster"] as SceneAsset,
		],
		[
			"6e6de455-9ff1-4d5c-a896-ff1426531791",
			{
				kind: "texture",
				width: 2,
				height: 2,
				format: "rgba8unorm-srgb",
				data: new Uint8Array(16),
				colorSpace: "srgb",
				mipmap: true,
			} satisfies TextureAsset,
		],
		[
			"263c8135-3f53-4e3d-9038-6c7288afce3f",
			{
				kind: "sampler",
				addressModeU: "repeat",
				addressModeV: "repeat",
				magFilter: "linear",
				minFilter: "linear",
				mipmapFilter: "linear",
			} satisfies SamplerAsset,
		],
	]);
	for (const dependency of missing) assets.delete(dependency);
	return {
		async readByGuid(requested) {
			const key = AssetGuid.format(requested);
			const asset = assets.get(key);
			if (asset === undefined) {
				return {
					ok: false,
					error: new AssetError({
						code: "asset-not-imported",
						expected: `sample dependency ${key} to be published`,
						hint: "publish the dependency pack before rebuilding the sample showcase",
					}),
				};
			}
			return ok({ asset, generation: 7, digest: `sha256:sample-${key}` });
		},
	};
}

async function buildShowcase(missing: readonly string[] = []) {
	return buildScriptablePack({
		definition: showcasePack,
		sourcePath: "assets/procedural-showcase.pack.ts",
		assetSource: await source(missing),
		outputs: createStandardAssetOutputProducerRegistry(),
		sourceClosure: [
			{ path: "assets/procedural-showcase.pack.ts", digest: "sha256:showcase" },
			{
				path: "assets/procedural-showcase.pack-lib.ts",
				digest: "sha256:showcase-lib",
			},
		],
		authoringContractVersion: "sample-scriptable/1",
	});
}

async function buildInputs() {
	return buildScriptablePack({
		definition: inputPack,
		sourcePath: "assets/procedural-inputs.pack.ts",
		outputs: createStandardAssetOutputProducerRegistry(),
		sourceClosure: [
			{ path: "assets/procedural-inputs.pack.ts", digest: "sha256:inputs" },
		],
		authoringContractVersion: "sample-scriptable/1",
	});
}

describe("sample ScriptablePack producer", () => {
	it("keeps custom VFX shaders on the Engine renderer binding ABI", async () => {
		for (const file of [
			"arc-nova-sigil.wgsl",
			"arc-nova-violet-sigil.wgsl",
		]) {
			const shader = await readFile(new URL(`../assets/vfx/${file}`, import.meta.url), "utf8");
			expect(shader).toContain("@group(0) @binding(0) var scene_depth: texture_depth_2d;");
			expect(shader).not.toContain("@group(0) @binding(0) var<uniform> view");
		}
		const flow = await readFile(new URL("../assets/vfx/arc-nova-flow.wgsl", import.meta.url), "utf8");
		expect(flow).toContain("@location(4) center: vec3<f32>");
		expect(flow).toContain("textureSample(flowTexture, flowTexture_sampler");
		expect(flow).not.toContain("texture_depth_2d");
		const effects = JSON.parse(
			await readFile(new URL("../assets/vfx/particle-effects.pack.json", import.meta.url), "utf8"),
		) as { assets: Array<{ payload?: { emitters?: Array<{ renderers?: Array<Record<string, unknown>> }> } }> };
		const flowRenderer = effects.assets[0]?.payload?.emitters?.[0]?.renderers?.[0];
		expect(flowRenderer).toMatchObject({
			kind: "mesh",
			mesh: "9a7e15c1-5d02-4d64-9001-1a2b3c4d5e01",
			submesh: 0,
		});
		expect(flowRenderer).not.toHaveProperty("blend");
	});

	it("declares every standard material value in the producer contract", async () => {
		const result = await buildShowcase();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const materials = result.value.product.assets.filter(
			(asset) => asset.kind === "material",
		);
		expect(materials).toHaveLength(3);
		for (const material of materials) {
			const payload = material.payload as {
				parameters?: Array<{ name?: string }>;
				values?: Record<string, unknown>;
			};
			const declared = new Set(
				payload.parameters?.map((parameter) => parameter.name),
			);
			expect(
				Object.keys(payload.values ?? {}).every((name) => declared.has(name)),
			).toBe(true);
		}
	});

	it("publishes the primitive input graph with reusable mesh slots", async () => {
		const result = await buildInputs();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.value.product.assets.filter((asset) => asset.kind === "mesh"),
		).toHaveLength(2);
		expect(
			result.value.product.assets.filter((asset) => asset.kind === "material"),
		).toHaveLength(1);
		expect(
			result.value.product.assets.filter((asset) => asset.kind === "scene"),
		).toHaveLength(1);
		const cluster = result.value.product.assets.find(
			(asset) => asset.guid === "019ffdb4-0000-7000-8000-000000000004",
		);
		expect(cluster?.kind).toBe("scene");
		if (cluster?.kind !== "scene") return;
		const payload = cluster.payload as unknown as SceneAsset;
		expect(payload.entities.map((entity) => entity.localId)).toEqual([0, 1]);
		expect(payload.entities[1]?.components.ChildOf).toEqual({ parent: 0 });
		expect(
			payload.entities.every(
				(entity) => entity.components.MeshFilter !== undefined,
			),
		).toBe(true);
		expect(
			payload.entities.every(
				(entity) => entity.components.MeshRenderer !== undefined,
			),
		).toBe(true);
	});

	it("publishes the fixed ordinary output matrix", async () => {
		const result = await buildShowcase();
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const assets = result.value.product.assets;
		expect(assets).toHaveLength(8);
		expect(assets.filter((asset) => asset.kind === "mesh")).toHaveLength(3);
		expect(assets.filter((asset) => asset.kind === "material")).toHaveLength(3);
		expect(assets.filter((asset) => asset.kind === "scene")).toHaveLength(2);
		expect(
			assets.every((asset) =>
				["mesh", "material", "scene"].includes(asset.kind),
			),
		).toBe(true);
	});

	it("publishes the arena mount DAG and cross-pack crystal receipt", async () => {
		const result = await buildShowcase();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const arena = result.value.product.assets.find(
			(asset) => asset.guid === "019ffdb4-1000-7000-8000-000000000008",
		);
		expect(arena?.kind).toBe("scene");
		if (arena?.kind !== "scene") return;
		const payload = arena.payload as unknown as SceneAsset;
		expect(payload.mounts).toHaveLength(11);
		const sourceGuid = (source: number | string) =>
			typeof source === "number" ? arena.refs[source]?.guid : source;
		expect(
			payload.mounts?.filter(
				(mount) =>
					sourceGuid(mount.source) === "019ffdb4-0000-7000-8000-000000000004",
			),
		).toHaveLength(3);
		expect(
			payload.mounts?.filter(
				(mount) =>
					sourceGuid(mount.source) === "019ffdb4-1000-7000-8000-000000000007",
			),
		).toHaveLength(8);
		const windows = payload.mounts?.map((mount) => [
			mount.memberFirst as number,
			(mount.memberFirst as number) + mount.memberCount,
		]);
		expect(new Set(windows?.map(([first]) => first)).size).toBe(
			payload.mounts?.length,
		);
		expect(result.value.externalEvidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					guid: "019ffdb4-0000-7000-8000-000000000004",
					usage: "both",
					generation: 7,
				}),
				expect.objectContaining({
					guid: "6e6de455-9ff1-4d5c-a896-ff1426531791",
					usage: "both",
					generation: 7,
				}),
				expect.objectContaining({
					guid: "263c8135-3f53-4e3d-9038-6c7288afce3f",
					usage: "both",
					generation: 7,
				}),
				expect.objectContaining({
					guid: "019f56f2-0ac0-776a-9d28-50eb5a9edeb9",
					usage: "reference",
				}),
			]),
		);
	});

	it("keeps GUIDs, refs, and fingerprints stable across consecutive builds", async () => {
		const first = await buildShowcase();
		const second = await buildShowcase();
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;

		expect(first.value.inputFingerprint).toBe(second.value.inputFingerprint);
		expect(first.value.product.assets.map((asset) => asset.guid)).toEqual(
			second.value.product.assets.map((asset) => asset.guid),
		);
		expect(first.value.product.assets.map((asset) => asset.refs)).toEqual(
			second.value.product.assets.map((asset) => asset.refs),
		);
		expect(
			first.value.stagedOutputs.map((output) => [output.guid, output.digest]),
		).toEqual(
			second.value.stagedOutputs.map((output) => [output.guid, output.digest]),
		);
		expect(
			first.value.product.assets.every((asset) => asset.guid.includes("-")),
		).toBe(true);
		expect(
			first.value.product.assets
				.flatMap((asset) => asset.refs)
				.every((ref) => typeof ref.guid === "string"),
		).toBe(true);
	});

	it("keeps gameplay markers deterministic and independent of generated local ids", async () => {
		const result = await buildShowcase();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const scenes = result.value.product.assets.filter(
			(asset) => asset.kind === "scene",
		);
		const markers = scenes.flatMap((asset) =>
			asset.kind === "scene"
				? (asset.payload as unknown as SceneAsset).entities.flatMap(
						(entity) => {
							const player = entity.components.ParticleEffectPlayer;
							return player === undefined ? [] : [player];
						},
					)
				: [],
		);
		expect(markers.every((marker) => marker.seed === 424242)).toBe(true);
		expect(
			markers.every(
				(marker) => marker.playing === true && marker.timeScale === 1,
			),
		).toBe(true);
		expect(
			scenes
				.flatMap((asset) =>
					asset.kind === "scene"
						? (asset.payload as unknown as SceneAsset).entities
						: [],
				)
				.every(
					(entity) =>
						!("generation" in entity.components) &&
						!("LocalEntityId" in entity.components),
				),
		).toBe(true);
	});

	it("does not execute a sample pack source in the runtime entry", async () => {
		const execution = await readFile(
			new URL("../execution.ts", import.meta.url),
			"utf8",
		);
		expect(execution).not.toMatch(/\.pack\.ts/);
		expect(execution).not.toMatch(/\.build\s*\(/);
	});

	it("keeps the asset-resident gameplay contract on the editor plugin owner", async () => {
		const plugin = await readFile(
			new URL("../assets/rotator.plugin.ts", import.meta.url),
			"utf8",
		);
		expect(plugin).toContain("from '@forgeax/editor-game-plugins'");
		expect(plugin).not.toContain("from '@forgeax/engine-app'");
		expect(plugin).toContain("onDispose");
		expect(plugin).not.toContain("lifecycle.register");
	});

	it("fails closed before output publication when a VFX texture or sampler is missing", async () => {
		for (const dependency of [
			"6e6de455-9ff1-4d5c-a896-ff1426531791",
			"263c8135-3f53-4e3d-9038-6c7288afce3f",
		]) {
			const result = await buildShowcase([dependency]);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.error).toMatchObject({ code: "asset-not-imported" });
			expect("product" in result).toBe(false);
		}
	});

	it("keeps the VFX sidecar receipt explicit instead of inferring closure from files", async () => {
		const shader = JSON.parse(
			await readFile(
				new URL(
					"../assets/vfx/arc-nova-flow.shader.pack.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			assets: Array<{
				refs?: string[];
				payload?: {
					values?: { flowTexture?: { texture?: string; sampler?: string } };
				};
			}>;
		};
		const sampler = JSON.parse(
			await readFile(
				new URL(
					"../assets/vfx/arc-nova-flow-sampler.pack.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			assets: Array<{ refs?: string[] }>;
		};
		expect(shader.assets[0]?.payload?.values?.flowTexture).toEqual({
			texture: "6e6de455-9ff1-4d5c-a896-ff1426531791",
			sampler: "263c8135-3f53-4e3d-9038-6c7288afce3f",
		});
		expect(shader.assets[0]?.refs).toEqual([
			"6e6de455-9ff1-4d5c-a896-ff1426531791",
			"263c8135-3f53-4e3d-9038-6c7288afce3f",
		]);
		expect(sampler.assets[0]?.refs).toEqual([]);
	});

	it("keeps the authored sample root with the Fox and Scriptable arena mounts", async () => {
		const forge = JSON.parse(
			await readFile(new URL("../forge.json", import.meta.url), "utf8"),
		) as {
			defaultScene: string;
		};
		const scene = JSON.parse(
			await readFile(
				new URL("../assets/scene.pack.json", import.meta.url),
				"utf8",
			),
		) as {
			assets: Array<{
				guid: string;
				payload?: {
					mounts?: Array<{
						localId: number;
						memberFirst: number;
						memberCount: number;
						source: number;
						parent?: number;
						overrides?: unknown[];
					}>;
				};
				refs?: string[];
			}>;
		};
		expect(forge.defaultScene).toBe("2b7c9a10-4d5e-5f60-8a1b-2c3d4e5f6071");
		const authored = scene.assets.find(
			(asset) => asset.guid === forge.defaultScene,
		);
		expect(authored?.payload?.mounts).toHaveLength(2);
		const foxMount = authored?.payload?.mounts?.find((candidate) => candidate.source === 5);
		const arenaMount = authored?.payload?.mounts?.find((candidate) => candidate.source === 8);
		expect(foxMount).toMatchObject({
			localId: 7,
			memberFirst: 8,
			memberCount: 26,
			source: 5,
			parent: 1,
		});
		expect(arenaMount).toMatchObject({
			localId: 35,
			memberFirst: 36,
			memberCount: 37,
			source: 8,
			parent: 1,
		});
		expect(arenaMount?.overrides).toBeUndefined();
		expect(authored?.refs?.[arenaMount?.source ?? -1]).toBe(
			"019ffdb4-1000-7000-8000-000000000008",
		);
		expect(authored?.refs).toContain(
			"019f56f2-0ac0-776a-9d28-50eb5a9edeb8",
		);
		expect(authored?.refs?.[foxMount?.source ?? -1]).toBe(
			"019f56f2-0ac0-776a-9d28-50eb5a9edeb8",
		);
	});

	it("round-trips the publication fence on the authored mount only", () => {
		const publicationFence = {
			schemaVersion: "scene-publication-fence/1" as const,
			sourcePath: "assets/procedural-showcase.pack.ts",
			sourceRevision: "sha256:showcase",
			publicationGeneration: 3,
			outputDigest: "sha256:arena",
			outputSetDigest: "sha256:arena-set",
			receiptIdentity: "sha256:showcase-inputs",
		};
		const scene: SceneAsset = {
			kind: "scene",
			entities: [{ localId: 0 as never, components: {} }],
			mounts: [
				{
					localId: 1 as never,
					source: "019ffdb4-1000-7000-8000-000000000008",
					memberFirst: 2 as never,
					memberCount: 1,
					parent: 0 as never,
					publicationFence,
				},
			],
		};
		const packed = serializeSceneAssetToPack(
			scene,
			"2b7c9a10-4d5e-5f60-8a1b-2c3d4e5f6071",
		);
		expect(packed.ok).toBe(true);
		if (!packed.ok) return;
		const serialized = packed.value.assets?.[0] as
			| { payload?: SceneAsset }
			| undefined;
		expect(serialized?.payload?.mounts?.[0]?.publicationFence).toEqual(
			publicationFence,
		);
		expect(serialized?.payload?.entities).toHaveLength(1);
	});

	it("accepts one non-overlapping mount window and rejects malformed fixtures before publication", () => {
		const valid: SceneAsset = {
			kind: "scene",
			entities: [{ localId: 0 as never, components: {} }],
			mounts: [sceneMount("crystal-cluster", 1, 2, 2)],
		};
		expect(valid.mounts).toHaveLength(1);
		expect(valid.mounts?.[0]?.memberFirst).toBe(2);
		expect(valid.mounts?.[0]?.memberCount).toBe(2);

		expect(() => sceneMount("crystal-cluster", -1, 2, 2)).toThrow(/localId/);
		expect(() => sceneMount("crystal-cluster", 1, 2, 0)).toThrow(/memberCount/);
		expect(() => sceneMount("", 1, 2, 2)).not.toThrow();

		const overlapping: SceneAsset = {
			kind: "scene",
			entities: [{ localId: 0 as never, components: {} }],
			mounts: [
				sceneMount("crystal-cluster", 1, 2, 2),
				sceneMount("crystal-cluster", 2, 4, 1),
			],
		};
		const overlapWorld = new World();
		const overlapHandle = overlapWorld.allocSharedRef(
			"SceneAsset",
			overlapping,
		);
		overlapWorld._setSceneAssetResolver(() => ok(overlapHandle));
		const overlapBefore = overlapWorld.inspect().entityCount;
		const overlapResult = overlapWorld.instantiateScene(overlapHandle);
		expect(overlapResult.ok).toBe(false);
		expect(
			overlapResult.ok
				? undefined
				: (overlapResult.error as { code?: string }).code,
		).toBe("pack-mount-localid-overlap");
		expect(overlapWorld.inspect().entityCount).toBe(overlapBefore);
	});

	it("fails closed for missing mount dependencies and cycles without a usable result", () => {
		const missing: SceneAsset = {
			kind: "scene",
			entities: [{ localId: 0 as never, components: {} }],
			mounts: [sceneMount("missing-scene", 1, 2, 1)],
		};
		const missingWorld = new World();
		const missingHandle = missingWorld.allocSharedRef("SceneAsset", missing);
		missingWorld._setSceneAssetResolver(() =>
			err({
				code: "asset-not-imported",
				expected: "published child scene",
				hint: "publish dependency first",
			}),
		);
		const missingResult = missingWorld.instantiateScene(missingHandle);
		expect(missingResult.ok).toBe(false);
		expect(
			missingResult.ok
				? undefined
				: (missingResult.error as { code?: string }).code,
		).toBe("asset-not-imported");

		const cycle: SceneAsset = {
			kind: "scene",
			entities: [{ localId: 0 as never, components: {} }],
			mounts: [sceneMount("cycle-scene", 1, 2, 1)],
		};
		const cycleWorld = new World();
		const cycleHandle = cycleWorld.allocSharedRef("SceneAsset", cycle);
		cycleWorld._setSceneAssetResolver(() => ok(cycleHandle));
		const cycleResult = cycleWorld.instantiateScene(cycleHandle);
		expect(cycleResult.ok).toBe(false);
		expect(
			cycleResult.ok
				? undefined
				: (cycleResult.error as { code?: string }).code,
		).toBe("pack-cyclic-reference");
	});
});
