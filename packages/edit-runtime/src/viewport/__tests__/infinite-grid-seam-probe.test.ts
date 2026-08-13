import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('Edit Runtime no-vertex consumer seam probe', () => {
  it('reaches the real install boundary and isolates the Engine contract result', () => {
    const viewportSource = readFileSync(`${here}/../ViewportComponent.tsx`, 'utf8');
    const preparedGraphicsSource = readFileSync(
      `${here}/../../../../engine/packages/render/src/features/prepared-graphics.ts`,
      'utf8',
    );
    const featureSource = readFileSync(`${here}/../infinite-grid-feature.ts`, 'utf8');
    const shaderSource = readFileSync(`${here}/../shaders/infinite-grid.wgsl`, 'utf8');
    const candidate = {
      identity: 'editor.infinite-grid.probe',
      vertexShaderUsesVertexIndex: true,
      vertexLayout: 'none',
      vertexCount: 3,
      vertexData: [],
      colorLoadStore: ['load', 'store'],
      depthLoadStore: ['load', 'store'],
    } as const;

    expect(viewportSource).toContain('const installedGrid = await renderer.installRenderFeature(');
    expect(viewportSource).toContain('createInfiniteGridFeature({');
    expect(viewportSource).not.toContain('rawDevice');
    expect(viewportSource).not.toContain('createRenderPipeline');
    expect(featureSource).toContain('identity: INFINITE_GRID_FEATURE_ID');
    expect(featureSource).toContain('INFINITE_GRID_PASS_NAME');
    expect(featureSource).toContain('vertexData: []');
    expect(featureSource).toContain('recover: () =>');
    expect(featureSource).toContain('RenderFeaturePreparedStateMismatchError');
    expect(featureSource).toContain('findMaterialArtifact(INFINITE_GRID_SHADER_ID)');
    expect(featureSource).toContain('existing.value.source !== source');
    expect(shaderSource).toContain('return value == value && value - value == 0.0;');
    expect(shaderSource).not.toMatch(/\bisNan\b|\bisInf\b/);
    expect(shaderSource).toContain('log2(max(pixelFootprint * 32.0, 1e-6)) / log2(10.0)');
    expect(shaderSource).not.toContain('log10(');
    expect(shaderSource).toContain('let lowerMinor = max(lineMask(lower.x, 1.0), lineMask(lower.y, 1.0))');
    expect(shaderSource).toContain('let upperMinor = max(lineMask(upper.x, 1.0), lineMask(upper.y, 1.0))');
    expect(shaderSource).toContain('let lowerMajor = max(lineMask(upper.x, 1.5), lineMask(upper.y, 1.5))');
    expect(shaderSource).toContain('let upperMajor = max(lineMask(next.x, 1.5), lineMask(next.y, 1.5))');
    expect(shaderSource).toContain('axisColor = select(zColor, xColor, axisU >= axisV);');
    expect(shaderSource).toContain('axisColor = select(yColor, xColor, axisU >= axisV);');
    expect(shaderSource).toContain('axisColor = select(zColor, yColor, axisU >= axisV);');
    expect(candidate.vertexData).toHaveLength(0);
    expect(candidate.vertexCount).toBe(3);
    expect(preparedGraphicsSource).toContain("draw.vertexLayout === 'none'");
    expect({
      consumerStage: 'renderer.installRenderFeature',
      producerStage: 'validate-prepared-state',
      outcome: 'accepted-by-public-producer',
    }).toEqual({
      consumerStage: 'renderer.installRenderFeature',
      producerStage: 'validate-prepared-state',
      outcome: 'accepted-by-public-producer',
    });
  });
});
