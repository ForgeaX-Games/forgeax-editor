#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let x = (vfx_random_spawn(ctx, 0u) - 0.5) * 5.0;
  let z = (vfx_random_spawn(ctx, 1u) - 0.5) * 5.0;
  let drift = (vfx_random_spawn(ctx, 2u) - 0.5) * 0.08;
  (*particle).position = vec3<f32>(x, -0.4, z);
  (*particle).velocity = vec3<f32>(drift, 0.22 + vfx_random_spawn(ctx, 3u) * 0.16, -drift);
  (*particle).color = vec4<f32>(0.9, 0.82, 0.62, 0.0);
  (*particle).sprite_size = vec2<f32>(0.035, 0.035);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 3.2 + vfx_random_spawn(ctx, 4u) * 1.6;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let alpha = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.72, 1.0, life));
  let size = mix(0.025, 0.07, sin(life * 3.14159265));
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = (*particle).sprite_rotation + ctx.delta * 0.35;
  (*particle).color = vec4<f32>(0.9, 0.82, 0.62, alpha * 0.55);
}
