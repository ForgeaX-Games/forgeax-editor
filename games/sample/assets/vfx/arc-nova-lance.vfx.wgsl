#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec4<f32>(0.0, -0.18, 0.0, 1.0);
  (*particle).velocity = vec4<f32>(0.0, 4.2, 0.0, 0.0);
  (*particle).color = vec4<f32>(0.18, 0.72, 1.0, 1.0);
  (*particle).size_rotation = vec4<f32>(2.2, 2.2, 0.0, 0.0);
  (*particle).lifetime = 0.94;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let flare = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.62, 1.0, life));
  (*particle).size_rotation = vec4<f32>(mix(2.2, 0.6, life), 0.0, 0.0, 0.0);
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.72, 0.95, 1.0), vec3<f32>(0.12, 0.08, 0.8), life), flare);
}
