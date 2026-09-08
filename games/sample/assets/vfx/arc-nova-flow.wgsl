#define_import_path sample_vfx::arc_nova_flow

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(4) center: vec3<f32>,
  @location(5) right: vec3<f32>,
  @location(6) up: vec3<f32>,
  @location(7) forward: vec3<f32>,
  @location(8) particleColor: vec4<f32>,
  @location(9) baseColor: vec4<f32>,
  @location(10) emissiveIntensity: vec4<f32>,
  @location(11) surface: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) local: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let offset = input.right * input.position.x + input.up * input.position.y + input.forward * input.position.z;
  output.position = vec4<f32>(input.center + offset, 1.0);
  output.color = input.particleColor * input.baseColor * material.tint;
  output.uv = input.uv;
  output.local = input.uv * 2.0 - vec2<f32>(1.0);
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
