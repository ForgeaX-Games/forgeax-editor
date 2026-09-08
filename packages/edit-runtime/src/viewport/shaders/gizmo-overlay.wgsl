#define_import_path editor::gizmo-overlay

// The editor-side CPU projection writes NDC xyz into the engine's standard
// 48-byte procedural vertex layout:
//   location 0 = position.xyz
//   location 1 = unused normal.xyz
//   location 2 = unused uv.xy
//   location 3 = color/tangent.xyz + alpha
struct GizmoVertexInput {
  @location(0) position : vec3<f32>,
  @location(3) color : vec4<f32>,
}

struct GizmoVertexOutput {
  @builtin(position) clip : vec4<f32>,
  @location(0) color : vec4<f32>,
}

@vertex
fn vs_main(input : GizmoVertexInput) -> GizmoVertexOutput {
  var output : GizmoVertexOutput;
  output.clip = vec4<f32>(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input : GizmoVertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
