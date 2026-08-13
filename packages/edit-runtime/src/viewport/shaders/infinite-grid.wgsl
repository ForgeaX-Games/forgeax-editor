#define_import_path editor::infinite-grid

#import forgeax_view::common::{view}

struct GridVertexOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) @interpolate(flat) plane : u32,
  @location(1) ndc : vec2<f32>,
}

struct GridFragmentOut {
  @location(0) color : vec4<f32>,
  @builtin(frag_depth) depth : f32,
}

fn finite(value : f32) -> bool {
  // Keep this compatible with the Composer/Naga-Oil version shipped by the
  // Engine: the direct non-finite-value builtins are not available in its
  // WGSL builtin surface.
  // IEEE self-comparison rejects NaN, while `value - value` becomes NaN for
  // either infinity and therefore rejects both non-finite classes.
  return value == value && value - value == 0.0;
}

fn finite3(value : vec3<f32>) -> bool {
  return finite(value.x) && finite(value.y) && finite(value.z);
}

fn unproject(ndc : vec2<f32>, depth : f32) -> vec3<f32> {
  let clip = view.inverseViewProj * vec4<f32>(ndc, depth, 1.0);
  return clip.xyz / max(abs(clip.w), 1e-6);
}

fn planeNormal(plane : u32) -> vec3<f32> {
  if plane == 1u { return vec3<f32>(0.0, 0.0, 1.0); }
  if plane == 2u { return vec3<f32>(1.0, 0.0, 0.0); }
  return vec3<f32>(0.0, 1.0, 0.0);
}

fn planeUv(world : vec3<f32>, plane : u32) -> vec2<f32> {
  if plane == 1u { return world.xy; }
  if plane == 2u { return world.yz; }
  return world.xz;
}

fn positiveMod(value : f32, modulus : f32) -> f32 {
  return value - floor(value / modulus) * modulus;
}

fn gridCoord(world : vec3<f32>, spacing : f32, plane : u32) -> vec2<f32> {
  let local = planeUv(world - view.cameraPos, plane);
  let cameraPhase = planeUv(view.cameraPos, plane);
  return (local + vec2<f32>(
    positiveMod(cameraPhase.x, spacing),
    positiveMod(cameraPhase.y, spacing),
  )) / spacing;
}

fn lineMask(coord : f32, widthPx : f32) -> f32 {
  let distanceToLine = abs(fract(coord - 0.5) - 0.5);
  let footprint = max(fwidth(coord), 1e-5);
  let pixelDistance = distanceToLine / footprint;
  return 1.0 - smoothstep(widthPx - 0.5, widthPx + 0.5, pixelDistance);
}

fn classifyPlane() -> u32 {
  let centerNear = unproject(vec2<f32>(0.0), 0.0);
  let centerFar = unproject(vec2<f32>(0.0), 1.0);
  let rightNear = unproject(vec2<f32>(1.0, 0.0), 0.0);
  let rightFar = unproject(vec2<f32>(1.0, 0.0), 1.0);
  let centerDirection = normalize(centerFar - centerNear);
  let rightDirection = normalize(rightFar - rightNear);
  let perspectiveSpan = length(cross(centerDirection, rightDirection));
  if perspectiveSpan > 1e-5 { return 0u; }
  let absolute = abs(centerDirection);
  if absolute.y >= 0.9995 { return 0u; }
  if absolute.x >= 0.9995 { return 2u; }
  if absolute.z >= 0.9995 { return 1u; }
  return 0u;
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> GridVertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let ndc = positions[vertexIndex];
  var out : GridVertexOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.plane = classifyPlane();
  out.ndc = ndc;
  return out;
}

@fragment
fn fs_main(input : GridVertexOut) -> GridFragmentOut {
  let nearWorld = unproject(input.ndc, 0.0);
  let farWorld = unproject(input.ndc, 1.0);
  let ray = farWorld - nearWorld;
  let normal = planeNormal(input.plane);
  let denominator = dot(ray, normal);
  if !finite3(nearWorld) || !finite3(farWorld) || abs(denominator) < 1e-6 { discard; }
  let distance = -dot(nearWorld, normal) / denominator;
  if !finite(distance) || distance <= 1e-6 { discard; }
  let world = nearWorld + ray * distance;
  if !finite3(world) { discard; }

  let baseUv = planeUv(world - view.cameraPos, input.plane);
  let derivatives = fwidth(baseUv);
  let pixelFootprint = max(max(abs(derivatives.x), abs(derivatives.y)), 1e-6);
  let level = log2(max(pixelFootprint * 32.0, 1e-6)) / log2(10.0);
  let lowerSpacing = pow(10.0, floor(level));
  let upperSpacing = lowerSpacing * 10.0;
  let lodBlend = smoothstep(0.2, 0.8, fract(level));
  let lower = gridCoord(world, lowerSpacing, input.plane);
  let upper = gridCoord(world, upperSpacing, input.plane);
  let next = gridCoord(world, upperSpacing * 10.0, input.plane);
  let lowerMinor = max(lineMask(lower.x, 1.0), lineMask(lower.y, 1.0)) * (1.0 - lodBlend);
  let upperMinor = max(lineMask(upper.x, 1.0), lineMask(upper.y, 1.0)) * lodBlend;
  let lowerMajor = max(lineMask(upper.x, 1.5), lineMask(upper.y, 1.5));
  let upperMajor = max(lineMask(next.x, 1.5), lineMask(next.y, 1.5));
  let minor = lowerMinor + upperMinor;
  let major = lowerMajor * (1.0 - lodBlend) + upperMajor * lodBlend;
  let worldUv = planeUv(world, input.plane);
  let axisU = lineMask(worldUv.x, 2.0);
  let axisV = lineMask(worldUv.y, 2.0);
  let axis = max(axisU, axisV);

  let clip = view.worldViewProj * vec4<f32>(world, 1.0);
  if !finite(clip.w) || abs(clip.w) < 1e-6 { discard; }
  let depth = clip.z / clip.w;
  if !finite(depth) || depth < 0.0 || depth > 1.0 { discard; }
  let grazing = smoothstep(0.02, 0.08, abs(dot(normalize(ray), normal)));
  let depthFade = 1.0 - smoothstep(0.55, 0.85, depth);
  let minorAlpha = minor * 0.18 * grazing * depthFade;
  let majorAlpha = major * 0.34 * grazing * depthFade;
  let axisAlpha = axis * 0.72 * grazing * depthFade;
  let neutral = vec3<f32>(0.30, 0.33, 0.38);
  let majorColor = vec3<f32>(0.42, 0.46, 0.52);
  let xColor = vec3<f32>(1.0, 0.25, 0.20);
  let yColor = vec3<f32>(0.35, 0.85, 0.45);
  let zColor = vec3<f32>(0.30, 0.55, 1.0);
  var axisColor = zColor;
  if input.plane == 0u {
    axisColor = select(zColor, xColor, axisU >= axisV);
  } else if input.plane == 1u {
    axisColor = select(yColor, xColor, axisU >= axisV);
  } else {
    axisColor = select(zColor, yColor, axisU >= axisV);
  }
  let alpha = max(max(minorAlpha, majorAlpha), axisAlpha);
  let rgb = (neutral * minorAlpha + majorColor * majorAlpha + axisColor * axisAlpha) / max(alpha, 1e-6);
  var out : GridFragmentOut;
  out.color = vec4<f32>(rgb * alpha, alpha);
  out.depth = depth;
  return out;
}
