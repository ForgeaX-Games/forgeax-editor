import { describe, expect, it } from 'bun:test';
import {
  inspectorFieldRendererKind,
  isUnsupportedRendererKind,
  isVectorRendererKind,
} from '../inspector-field-shape';

describe('Inspector schema-shape renderer', () => {
  it('derives controls from producer shape rather than storage type', () => {
    expect(inspectorFieldRendererKind({ type: 'number', shape: 'boolean' })).toBe('boolean');
    expect(inspectorFieldRendererKind({ type: 'number', shape: 'enum' })).toBe('enum');
    expect(inspectorFieldRendererKind({ type: 'vec', shape: 'quaternion' })).toBe('quaternion');
    expect(inspectorFieldRendererKind({ type: 'asset', shape: 'asset-ref' })).toBe('asset-ref');
  });

  it('covers every R0-03A shape without a component-name input', () => {
    const shapes = ['scalar', 'boolean', 'enum', 'vector', 'quaternion', 'optional', 'nested', 'array', 'asset-ref'] as const;
    const kinds = shapes.map((shape) => inspectorFieldRendererKind({ type: 'number', shape }));
    expect(kinds).toEqual(['scalar', 'boolean', 'enum', 'vector', 'quaternion', 'optional', 'nested', 'array', 'asset-ref']);
  });

  it('keeps legacy untagged fields rendering through their storage/editor type', () => {
    expect(inspectorFieldRendererKind({ type: 'number' })).toBe('scalar');
    expect(inspectorFieldRendererKind({ type: 'string' })).toBe('text');
    expect(inspectorFieldRendererKind({ type: 'bool' })).toBe('boolean');
    expect(inspectorFieldRendererKind({ type: 'vec' })).toBe('vector');
  });

  it('fails closed for an unknown runtime shape', () => {
    const kind = inspectorFieldRendererKind({ type: 'number', shape: 'future-shape' as never });
    expect(kind).toBe('unsupported');
    expect(isUnsupportedRendererKind(kind)).toBe(true);
  });

  it('identifies vector and quaternion controls as the tuple renderer family', () => {
    expect(isVectorRendererKind('vector')).toBe(true);
    expect(isVectorRendererKind('quaternion')).toBe(true);
    expect(isVectorRendererKind('scalar')).toBe(false);
  });

  it('treats optional and arrays as editable, while opaque nested refs remain closed', () => {
    expect(isUnsupportedRendererKind('optional')).toBe(false);
    expect(isUnsupportedRendererKind('nested')).toBe(true);
    expect(isUnsupportedRendererKind('array')).toBe(false);
  });
});
