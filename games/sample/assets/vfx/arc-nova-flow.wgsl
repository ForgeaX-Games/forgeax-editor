#define_import_path sample_vfx::arc_nova_flow

struct View { reserved: vec4<f32> };

@group(0) @binding(0) var<uniform> view: View;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) right: vec2<f32>,
  @location(2) up: vec2<f32>,
  @location(3) particleColor: vec4<f32>,
  @location(4) baseColor: vec4<f32>,
  @location(5) emissiveIntensity: vec4<f32>,
  @location(6) surface: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) local: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let corner = corners[vertexIndex];
  var output: VertexOutput;
  output.position = vec4<f32>(
    input.position.xy + input.right * corner.x + input.up * corner.y,
    input.position.z,
    1.0,
  );
  output.color = input.particleColor * input.baseColor * material.tint;
  output.uv = corner * 0.5 + 0.5;
  output.local = corner;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let radial = length(input.local);
  let direction = normalize(input.local + vec2<f32>(0.0001));
  let warpedUv = input.uv + direction * material.distortion * (1.0 - radial);
  let flow = textureSample(flowTexture, flowTexture_sampler, warpedUv);
  let edge = pow(clamp(1.0 - radial, 0.0, 1.0), material.edgePower);
  let runes = flow.a * smoothstep(1.02, 0.15, radial);
  if (runes * edge < 0.02) { discard; }
  let chroma = mix(input.color.rgb, flow.rgb * 2.6, flow.a);
  let alpha = input.color.a * runes * edge;
  return vec4<f32>(chroma * alpha, alpha);
}
