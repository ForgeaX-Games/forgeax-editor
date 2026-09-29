#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.22, 0.0);
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.42, 0.08, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.36, 0.36);
  (*particle).sprite_rotation = 0.35;
  (*particle).mesh_scale = vec3<f32>(0.36, 0.36, 0.36);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin((*particle).sprite_rotation * 0.5), cos((*particle).sprite_rotation * 0.5));
  (*particle).lifetime = 0.92;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let eased = 1.0 - (1.0 - life) * (1.0 - life);
  let size = mix(0.6, 6.2, eased);
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = (*particle).sprite_rotation - ctx.delta * 0.7;
  (*particle).mesh_scale = vec3<f32>(size, size, size);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin((*particle).sprite_rotation * 0.5), cos((*particle).sprite_rotation * 0.5));
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.78, 0.42, 1.0), vec3<f32>(0.04, 0.18, 1.0), life), 1.0 - smoothstep(0.38, 1.0, life));
}
