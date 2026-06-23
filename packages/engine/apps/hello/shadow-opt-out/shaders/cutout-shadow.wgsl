#define_import_path shadow_opt_out::cutout_shadow

// apps/hello/shadow-opt-out/shaders/cutout-shadow.wgsl
// feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat T-018
// AC-17 cutout shadow shader: alpha-test discard in fragment stage so the
// shadow map produces a cutout pattern instead of a solid silhouette.
// AI users register this via ShaderRegistry.registerMaterialShader and
// reference it in a MaterialPassDescriptor with name='ShadowCaster' and
// tags={LightMode:'ShadowCaster'}.

#import forgeax_view::common::{View, Mesh, InstanceData, view, meshes, instances}

struct VsInput {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos   : vec3<f32>,
};

@vertex
fn vs_main(in : VsInput, @builtin(instance_index) idx : u32) -> VsOut {
  let worldPos = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(in.position, 1.0);
  var out : VsOut;
  out.clip = view.lightViewProj_A * worldPos;
  out.worldPos = worldPos.xyz;
  return out;
}

// Cutout pattern: discard fragments whose world-space X falls inside a
// vertical grid of holes (every 0.5 units along X, hole width 0.15).
// World-space Z modulo 0.5 also creates holes along the Z axis.
// Result: a checkerboard-cutout shadow on the cube surface.
@fragment
fn fs_main(in : VsOut) -> @builtin(frag_depth) f32 {
  let hole_x = abs((in.worldPos.x + 0.25) % 1.0 - 0.5) < 0.15;
  let hole_z = abs((in.worldPos.z + 0.25) % 1.0 - 0.5) < 0.15;
  if (hole_x && hole_z) {
    discard;
  }
  return in.clip.z / in.clip.w;
}