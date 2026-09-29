#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.24, 0.0);
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.42, 0.78, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.72, 0.72);
  (*particle).sprite_rotation = -0.28;
  (*particle).mesh_scale = vec3<f32>(0.72, 0.72, 0.72);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin((*particle).sprite_rotation * 0.5), cos((*particle).sprite_rotation * 0.5));
  (*particle).lifetime = 1.82;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let enter = smoothstep(0.0, 0.12, life);
  let leave = 1.0 - smoothstep(0.62, 1.0, life);
  let pulse = 0.94 + sin(life * 18.849556) * 0.06;
  let size = mix(1.2, 10.8, 1.0 - (1.0 - enter) * (1.0 - enter)) * pulse;
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = (*particle).sprite_rotation + ctx.delta * 0.34;
  (*particle).mesh_scale = vec3<f32>(size, size, size);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin((*particle).sprite_rotation * 0.5), cos((*particle).sprite_rotation * 0.5));
  (*particle).color = vec4<f32>(
    mix(vec3<f32>(0.2, 0.68, 1.0), vec3<f32>(0.64, 0.18, 1.0), life),
    enter * leave,
  );
}
