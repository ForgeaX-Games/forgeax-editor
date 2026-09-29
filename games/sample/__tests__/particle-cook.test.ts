import { readFile } from "node:fs/promises";
import { cookParticleCodeEffect } from "@forgeax/engine-vfx-compiler";
import { expect, it } from "vitest";

it("cold cooks every sample particle effect with the current Program compiler", async () => {
  const root = new URL("../assets/vfx/", import.meta.url);
  const pack = JSON.parse(await readFile(new URL("particle-effects.pack.json", root), "utf8"));
  for (const asset of pack.assets) {
    const modules: Record<string, { entry: string }> = {};
    for (const emitter of asset.payload.emitters) {
      modules[emitter.program.module] = { entry: await readFile(new URL(emitter.program.module, root), "utf8") };
    }
    const result = await cookParticleCodeEffect(asset.payload, modules);
    expect(result.ok, result.ok ? asset.name : JSON.stringify(result.error)).toBe(true);
  }
});
