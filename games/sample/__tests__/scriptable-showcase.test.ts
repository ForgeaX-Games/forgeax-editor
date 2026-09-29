import { World } from "@forgeax/engine-ecs";
import { SceneInstance } from "@forgeax/engine-render";
import {
	ChildOf,
	worldInstantiateScene,
	worldSetSceneAssetResolver,
} from "@forgeax/engine-scene";
import { readFile } from "node:fs/promises";
import {
	buildScriptablePack,
	createStandardAssetOutputProducerRegistry,
	type ScriptablePackAssetSnapshotSource,
} from "@forgeax/engine-import";
import { AssetGuid } from "@forgeax/engine-pack/guid";
import type {
	Asset,
	AssetGuid as AssetGuidType,
	MeshAsset,
	SamplerAsset,
	SceneAsset,
	TextureAsset,
} from "@forgeax/engine-types";
import { AssetError, err, ok } from "@forgeax/engine-types";
import { describe, expect, it } from "vitest";
import inputPack, { INPUT_ASSET_IDS } from "../assets/procedural-inputs.pack";
import showcasePack from "../assets/procedural-showcase.pack";
import { SAMPLE_SCENE_COMPONENTS } from "../assets/procedural-showcase.pack-lib";

const TEMPLATE_GUID = "3e915dea-1871-5b8d-b182-e4c8d1663194";
const ACCENT_GUID = "b6b811da-3b1e-5087-96c6-d5f835fbddb3";

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
			"73f94bbf-1b57-58d1-afbf-023bdaab0b6d",
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
						code: "pack-output-reference-missing",
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
		availableGuids: [
			...Object.values(INPUT_ASSET_IDS).map((entry) =>
				AssetGuid.format(entry.guid),
			),
			"6e6de455-9ff1-4d5c-a896-ff1426531791",
			"263c8135-3f53-4e3d-9038-6c7288afce3f",
			"019f56f2-0ac0-776a-9d28-50eb5a9edeb9",
		].filter((id) => !missing.includes(id)),
		outputs: createStandardAssetOutputProducerRegistry(SAMPLE_SCENE_COMPONENTS),
		sourceClosure: [
			{ path: "assets/procedural-showcase.pack.ts", digest: "sha256:showcase" },
			{
				path: "assets/procedural-showcase.pack-lib.ts",
				digest: "sha256:showcase-lib",
			},
		],
		authoringContractVersion: "sample-scriptable/2",
	});
}

async function buildInputs() {
	return buildScriptablePack({
		definition: inputPack,
		sourcePath: "assets/procedural-inputs.pack.ts",
		outputs: createStandardAssetOutputProducerRegistry(SAMPLE_SCENE_COMPONENTS),
		sourceClosure: [
			{ path: "assets/procedural-inputs.pack.ts", digest: "sha256:inputs" },
		],
		authoringContractVersion: "sample-scriptable/2",
	});
}

describe("sample ScriptablePack producer", () => {
	it("keeps custom VFX shaders on the Engine renderer binding ABI", async () => {
		for (const file of ["arc-nova-sigil.wgsl", "arc-nova-violet-sigil.wgsl"]) {
			const shader = await readFile(
				new URL(`../assets/vfx/${file}`, import.meta.url),
				"utf8",
			);
			expect(shader).toContain(
				"@group(0) @binding(0) var scene_depth: texture_depth_2d;",
			);
			expect(shader).not.toContain("@group(0) @binding(0) var<uniform> view");
		}
		const flow = await readFile(
			new URL("../assets/vfx/arc-nova-flow.wgsl", import.meta.url),
			"utf8",
		);
		expect(flow).toContain("@location(4) center: vec3<f32>");
		expect(flow).toContain("textureSample(flowTexture, flowTexture_sampler");
		expect(flow).not.toContain("texture_depth_2d");
		const effects = JSON.parse(
			await readFile(
				new URL("../assets/vfx/particle-effects.pack.json", import.meta.url),
				"utf8",
			),
		) as {
			assets: Array<{
				payload?: {
					emitters?: Array<{ renderers?: Array<Record<string, unknown>> }>;
				};
			}>;
		};
		const flowRenderer =
			effects.assets[0]?.payload?.emitters?.[0]?.renderers?.[0];
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

	it("publishes the fixed ordinary output matrix", async () => {
		const result = await buildShowcase();
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const assets = result.value.product.assets;
		expect(assets).toHaveLength(8);
		expect(assets.filter((asset) => asset.kind === "mesh")).toHaveLength(3);
		expect(assets.filter((asset) => asset.kind === "material")).toHaveLength(3);
		expect(assets.filter((asset) => asset.kind === "scene")).toHaveLength(2);
		for (const asset of assets.filter(
			(candidate) => candidate.kind === "mesh",
		)) {
			const payload = asset.payload as MeshAsset;
			expect(Object.keys(payload.attributes)).toEqual(
				expect.arrayContaining(["position", "normal", "uv", "tangent"]),
			);
			expect(payload.attributes.position).toHaveLength(
				(payload.vertices.length / 12) * 3,
			);
			expect(payload.attributes.normal).toHaveLength(
				(payload.vertices.length / 12) * 3,
			);
			expect(payload.attributes.uv).toHaveLength(
				(payload.vertices.length / 12) * 2,
			);
			expect(payload.attributes.tangent).toHaveLength(
				(payload.vertices.length / 12) * 4,
			);
		}
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
			(asset) => asset.guid === "b05d3430-4c47-558d-9201-f2a8e54f8771",
		);
		expect(arena?.kind).toBe("scene");
		if (arena?.kind !== "scene") return;
		const payload = arena.payload as unknown as SceneAsset;
		const instances = Object.values(payload.entities).flatMap((entity) =>
			entity.instance ? [entity.instance] : [],
		);
		expect(instances).toHaveLength(11);
		const sourceGuid = (source: number | string) =>
			typeof source === "number" ? arena.refs[source]?.guid : source;
		expect(
			instances.filter(
				(mount) =>
					sourceGuid(mount.source) === "73f94bbf-1b57-58d1-afbf-023bdaab0b6d",
			),
		).toHaveLength(3);
		expect(
			instances.filter(
				(mount) =>
					sourceGuid(mount.source) === "3406dad5-c484-5fe0-b241-c5895a054192",
			),
		).toHaveLength(8);
		expect(Object.keys(payload.entities)).toHaveLength(15);
		expect(arena.refs).toContainEqual(
			expect.objectContaining({ guid: "019f56f2-0ac0-776a-9d28-50eb5a9edeb9" }),
		);
		expect(result.value.externalEvidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					guid: "73f94bbf-1b57-58d1-afbf-023bdaab0b6d",
					usage: "both",
					generation: 7,
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
				? Object.values(
						(asset.payload as unknown as SceneAsset).entities,
					).flatMap((entity) => {
						const player = entity.components.ParticleEffectPlayer;
						return player === undefined ? [] : [player];
					})
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
						? Object.values((asset.payload as unknown as SceneAsset).entities)
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
			expect(result.error).toMatchObject({
				code: "pack-output-reference-missing",
			});
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
});

describe("sample keyed scene publication", () => {
	it("publishes the input scene with stable keys and derived GUIDs", async () => {
		const result = await buildInputs();
		if (!result.ok) throw result.error;
		expect(result.value.product.assets).toHaveLength(4);
		for (const [sourceKey, declaration] of Object.entries(INPUT_ASSET_IDS)) {
			const derived = AssetGuid.format(
				AssetGuid.derive(inputPack.packageId, sourceKey),
			);
			expect(derived).toBe(AssetGuid.format(declaration.guid));
			expect(
				result.value.product.assets.find((asset) => asset.guid === derived)
					?.kind,
			).toBe(declaration.kind);
		}
		const scene = result.value.product.assets.find(
			(asset) => asset.kind === "scene",
		)?.payload as SceneAsset;
		expect(Object.keys(scene.entities)).toEqual(["entity-0", "entity-1"]);
		expect(scene.entities["entity-1"]?.components.ChildOf).toEqual({
			parent: "entity-0",
		});
		expect(scene).not.toHaveProperty("mounts");
	});

	it("keeps the authored root connected to the Fox and migrated arena instances", async () => {
		const scene = JSON.parse(
			await readFile(
				new URL("../assets/scene.pack.json", import.meta.url),
				"utf8",
			),
		);
		const root = scene.assets[0];
		const instances = Object.values(
			root.payload.entities as Record<
				string,
				{
					components: { ChildOf?: { parent: string } };
					instance?: { source: number };
				}
			>,
		).filter((entity) => entity.instance);
		expect(instances).toHaveLength(2);
		expect(
			instances.every(
				(entity) => entity.components.ChildOf?.parent === "entity-1",
			),
		).toBe(true);
		expect(
			instances.map((entity) => root.refs[entity.instance!.source]),
		).toEqual(
			expect.arrayContaining([
				"019f56f2-0ac0-776a-9d28-50eb5a9edeb8",
				AssetGuid.format(
					AssetGuid.derive(showcasePack.packageId, "scene/scriptable-showcase"),
				),
			]),
		);
		for (const [key, entity] of Object.entries(root.payload.entities) as [
			string,
			{ components: { Entity?: { self: string } } },
		][]) {
			if (entity.components.Entity)
				expect(entity.components.Entity.self).toBe(key);
		}
		expect(root.payload).not.toHaveProperty("mounts");
	});
});

it("rejects missing keyed instance sources and recursive instances", () => {
	for (const cyclic of [false, true]) {
		const world = new World();
		world.components.register(ChildOf).unwrap();
		world.components.register(SceneInstance).unwrap();
		const scene: SceneAsset = {
			kind: "scene",
			entities: {
				child: {
					components: {},
					instance: { source: "11111111-1111-4111-8111-111111111111" },
				},
			},
		};
		const handle = world.allocSharedRef("SceneAsset", scene);
		worldSetSceneAssetResolver(world, () =>
			cyclic
				? ok(handle)
				: err({
						code: "asset-not-imported",
						expected: "published child scene",
						hint: "publish dependency first",
					}),
		);
		const result = worldInstantiateScene(world, handle);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.code).toBe(
				cyclic ? "pack-cyclic-reference" : "asset-not-imported",
			);
	}
});
