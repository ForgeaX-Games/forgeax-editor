#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = 0.24 + vfx_random_spawn(ctx, 1u) * 0.36;
  (*particle).position = vec4<f32>(cos(angle) * radius, 0.18, sin(angle) * radius, 1.0);
  (*particle).velocity = vec4<f32>(0.0, 0.12, 0.0, 0.0);
  (*particle).color = vec4<f32>(0.08, 0.65, 1.0, 1.0);
  (*particle).size_rotation = vec4<f32>(0.24, 0.24, angle, 0.0);
  (*particle).lifetime = 1.18;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let pulse = sin(life * 3.14159265);
  let size = mix(0.24, 2.76, pulse);
  (*particle).size_rotation = vec4<f32>(size, size, (*particle).size_rotation.z + ctx.delta, 0.0);
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.05, 0.4, 1.0), vec3<f32>(0.5, 0.1, 1.0), life), 1.0 - life);
}
