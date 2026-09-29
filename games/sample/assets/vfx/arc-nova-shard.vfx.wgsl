#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = vfx_random_spawn(ctx, 1u) * 1.3;
  let speed = 1.8 + vfx_random_spawn(ctx, 2u) * 1.8;
  (*particle).position = vec3<f32>(cos(angle) * radius, 0.12, sin(angle) * radius);
  (*particle).velocity = vec3<f32>(cos(angle) * 0.35, speed, sin(angle) * 0.35);
  (*particle).color = vec4<f32>(1.0, 0.38 + vfx_random_spawn(ctx, 3u) * 0.45, 0.04, 1.0);
  (*particle).sprite_size = vec2<f32>(0.56, 0.56);
  (*particle).sprite_rotation = angle;
  (*particle).mesh_scale = vec3<f32>(0.56, 0.56, 0.56);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin((*particle).sprite_rotation * 0.5), cos((*particle).sprite_rotation * 0.5));
  (*particle).lifetime = 0.9 + vfx_random_spawn(ctx, 4u) * 0.65;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let drag = max(0.0, 1.0 - 0.16 * ctx.delta);
  (*particle).velocity = vec3<f32>((*particle).velocity.x * drag, ((*particle).velocity.y - 1.35 * ctx.delta) * drag, (*particle).velocity.z * drag);
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let size = mix(1.2, 0.16, life);
  (*particle).sprite_size = vec2<f32>(size, size * 1.8);
  (*particle).sprite_rotation = (*particle).sprite_rotation + ctx.delta * 2.8;
  (*particle).mesh_scale = vec3<f32>(size, size * 1.8, size);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin((*particle).sprite_rotation * 0.5), cos((*particle).sprite_rotation * 0.5));
  (*particle).color = vec4<f32>(mix(vec3<f32>(1.0, 0.7, 0.15), vec3<f32>(0.35, 0.01, 0.0), life), 1.0 - life);
}
