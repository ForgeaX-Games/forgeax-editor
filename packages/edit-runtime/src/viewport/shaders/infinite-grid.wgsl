#define_import_path editor::infinite-grid

struct View {
  worldViewProj   : mat4x4<f32>,
  lightDir        : vec3<f32>,
  lightColor      : vec3<f32>,
  cameraPos       : vec3<f32>,
  lightViewProj_A : mat4x4<f32>,
  inverseViewProj : mat4x4<f32>,
  lightViewProj_B : mat4x4<f32>,
  lightViewProj_C : mat4x4<f32>,
  lightViewProj_D : mat4x4<f32>,
  splitPlanes     : array<vec4<f32>,4>,
  cascadeCount    : f32,
  cascadeBlend    : f32,
  depthBias       : f32,
  normalBias      : f32,
  pcfKernelSize   : f32,
  spotLightViewProj : array<mat4x4<f32>, 4>,
};

@group(0) @binding(0) var<uniform> view : View;

struct GridVertexOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) @interpolate(flat) plane : u32,
  @location(1) @interpolate(linear) ndc : vec2<f32>,
}

struct GridFragmentOut {
  @location(0) color : vec4<f32>,
  @builtin(frag_depth) depth : f32,
}

// Do not reconstruct exactly at the far-plane boundary: homogeneous w is
// close to zero there and loses precision even though the ray direction is
// still well-defined.
const RAY_FAR_DEPTH : f32 = 0.99;
const GRID_FADE_START : f32 = 28.0;
const GRID_FADE_END : f32 = 180.0;
const GRID_OPACITY : f32 = 0.28;
const GRID_MINOR_ALPHA : f32 = 0.08;
const GRID_MAJOR_ALPHA : f32 = 0.40;
const GRID_AXIS_ALPHA : f32 = 0.12;
// Minor marks are 1:5 against major marks before distance and grazing fade.
// Keep the default horizontal XZ grid just below the authored ground plane so
// it does not share a depth surface with ground geometry. The normal depth
// test still decides whether authored geometry occludes the viewport chrome.
const GRID_HEIGHT_OFFSET : f32 = -0.2;

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

fn finite4(value : vec4<f32>) -> bool {
  return finite(value.x) && finite(value.y) && finite(value.z) && finite(value.w);
}

fn safeCameraPosition() -> vec3<f32> {
  return select(vec3<f32>(0.0), view.cameraPos, finite3(view.cameraPos));
}

// The WebGPU shader path used by the editor has produced non-finite results
// for direct mat4*vec4 expressions against the shared View UBO. Keep the
// operation scalar and column-explicit; this is equivalent to the WGSL
// multiplication while avoiding that backend/compiler path.
fn multiplyMatrix(matrix : mat4x4<f32>, point : vec4<f32>) -> vec4<f32> {
  let column0 = matrix[0];
  let column1 = matrix[1];
  let column2 = matrix[2];
  let column3 = matrix[3];
  return vec4<f32>(
    column0.x * point.x + column1.x * point.y + column2.x * point.z + column3.x * point.w,
    column0.y * point.x + column1.y * point.y + column2.y * point.z + column3.y * point.w,
    column0.z * point.x + column1.z * point.y + column2.z * point.z + column3.z * point.w,
    column0.w * point.x + column1.w * point.y + column2.w * point.z + column3.w * point.w,
  );
}

fn divideClip(clip : vec4<f32>) -> vec3<f32> {
  let safeW = select(-1e-6, 1e-6, clip.w >= 0.0);
  return clip.xyz / select(safeW, clip.w, abs(clip.w) >= 1e-6);
}

fn unprojectClip(ndc : vec2<f32>, depth : f32) -> vec4<f32> {
  return multiplyMatrix(view.inverseViewProj, vec4<f32>(ndc, depth, 1.0));
}

fn unproject(ndc : vec2<f32>, depth : f32) -> vec3<f32> {
  return divideClip(unprojectClip(ndc, depth));
}

fn projectWorld(world : vec3<f32>) -> vec4<f32> {
  return multiplyMatrix(view.worldViewProj, vec4<f32>(world, 1.0));
}

fn planeCoordinate(worldClip : vec4<f32>, plane : u32) -> f32 {
  if plane == 1u { return worldClip.z; }
  if plane == 2u { return worldClip.x; }
  return worldClip.y - GRID_HEIGHT_OFFSET * worldClip.w;
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
  let cameraPosition = safeCameraPosition();
  let local = planeUv(world - cameraPosition, plane);
  let cameraPhase = planeUv(cameraPosition, plane);
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

// Unlike the periodic minor/major line mask, axis color belongs only to the
// two lines crossing the world origin. This keeps the center-line treatment
// separate from ordinary grid lines and prevents red/green axis colors from
// tinting every small division.
fn originLineMask(coord : f32, widthPx : f32) -> f32 {
  let footprint = max(fwidth(coord), 1e-5);
  let pixelDistance = abs(coord) / footprint;
  return 1.0 - smoothstep(widthPx - 0.5, widthPx + 0.5, pixelDistance);
}

fn classifyPlane() -> u32 {
  let centerNear = unproject(vec2<f32>(0.0), 0.0);
  let centerFar = unproject(vec2<f32>(0.0), RAY_FAR_DEPTH);
  let rightNear = unproject(vec2<f32>(1.0, 0.0), 0.0);
  let rightFar = unproject(vec2<f32>(1.0, 0.0), RAY_FAR_DEPTH);
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
  let nearClip = unprojectClip(input.ndc, 0.0);
  let farClip = unprojectClip(input.ndc, RAY_FAR_DEPTH);
  let normal = planeNormal(input.plane);
  if !finite4(nearClip) || !finite4(farClip) { discard; }
  // Plane intersection is linear in homogeneous coordinates. This avoids
  // dividing both endpoints before solving the ray and remains stable near
  // the horizon where the far endpoint has a very small w.
  let nearPlane = planeCoordinate(nearClip, input.plane);
  let farPlane = planeCoordinate(farClip, input.plane);
  let denominator = farPlane - nearPlane;
  if !finite(denominator) || abs(denominator) < 1e-6 { discard; }
  let segment = -nearPlane / denominator;
  if !finite(segment) { discard; }
  let worldClip = nearClip + (farClip - nearClip) * segment;
  if !finite4(worldClip) { discard; }
  let world = divideClip(worldClip);
  if !finite3(world) { discard; }

  let cameraPosition = safeCameraPosition();
  let toWorld = world - cameraPosition;
  let distance = length(toWorld);
  if !finite(distance) || distance <= 1e-6 { discard; }
  let rayDirection = normalize(toWorld);
  let baseUv = planeUv(world - cameraPosition, input.plane);
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
  let axisU = originLineMask(worldUv.x, 2.0);
  let axisV = originLineMask(worldUv.y, 2.0);
  let axis = max(axisU, axisV);

  let clip = projectWorld(world);
  if !finite4(clip) || abs(clip.w) < 1e-6 { discard; }
  let depth = clip.z / clip.w;
  if !finite(depth) || depth < 0.0 || depth > 1.0 { discard; }
  let grazing = smoothstep(0.02, 0.08, abs(dot(rayDirection, normal)));
  let distanceFade = (1.0 - smoothstep(GRID_FADE_START, GRID_FADE_END, distance)) * GRID_OPACITY;
  let minorAlpha = minor * GRID_MINOR_ALPHA * grazing * distanceFade;
  let majorAlpha = major * GRID_MAJOR_ALPHA * grazing * distanceFade;
  let axisAlpha = axis * GRID_AXIS_ALPHA * grazing * distanceFade;
  let neutral = vec3<f32>(0.24, 0.32, 0.27);
  let majorColor = vec3<f32>(0.38, 0.52, 0.42);
  let xColor = vec3<f32>(0.86, 0.24, 0.20);
  let yColor = vec3<f32>(0.26, 0.70, 0.36);
  let zColor = vec3<f32>(0.24, 0.62, 0.34);
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
