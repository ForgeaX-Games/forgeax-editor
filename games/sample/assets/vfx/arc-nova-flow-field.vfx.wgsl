#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec4<f32>(0.0, 0.24, 0.0, 1.0);
  (*particle).velocity = vec4<f32>(0.0);
  (*particle).color = vec4<f32>(0.42, 0.78, 1.0, 1.0);
  (*particle).size_rotation = vec4<f32>(0.72, 0.72, -0.28, 0.0);
  (*particle).lifetime = 1.82;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let enter = smoothstep(0.0, 0.12, life);
  let leave = 1.0 - smoothstep(0.62, 1.0, life);
  let pulse = 0.94 + sin(life * 18.849556) * 0.06;
  let size = mix(1.2, 10.8, 1.0 - (1.0 - enter) * (1.0 - enter)) * pulse;
  (*particle).size_rotation = vec4<f32>(size, size, (*particle).size_rotation.z + ctx.delta * 0.34, 0.0);
  (*particle).color = vec4<f32>(
    mix(vec3<f32>(0.2, 0.68, 1.0), vec3<f32>(0.64, 0.18, 1.0), life),
    enter * leave,
  );
}
