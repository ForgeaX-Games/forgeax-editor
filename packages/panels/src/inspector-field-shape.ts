import type { FieldSchema, FieldType } from '@forgeax/editor-core';

/**
 * The Inspector's rendering vocabulary is derived from producer shape first.
 * `FieldSchema.type` remains the storage/editor fallback for older producers
 * that have not annotated a semantic shape yet.
 */
export type InspectorFieldRendererKind =
  | 'scalar'
  | 'text'
  | 'boolean'
  | 'enum'
  | 'vector'
  | 'quaternion'
  | 'asset-ref'
  | 'optional'
  | 'nested'
  | 'array'
  | 'unsupported';

type FieldShapeInput = Pick<FieldSchema, 'type' | 'shape'> | undefined;

function legacyRendererKind(type: FieldType | undefined): InspectorFieldRendererKind {
  switch (type) {
    case 'number': return 'scalar';
    case 'string': return 'text';
    case 'bool': return 'boolean';
    case 'enum': return 'enum';
    case 'vec': return 'vector';
    case 'asset': return 'asset-ref';
    case 'array': return 'array';
    case 'nested': return 'nested';
    case 'color': return 'vector';
    default: return 'unsupported';
  }
}

/**
 * Resolve one field to the semantic renderer kind. The switch is over the
 * producer-owned shape vocabulary, never over a component name. Unknown
 * runtime values deliberately become `unsupported` so a new shape cannot be
 * rendered by an unrelated control by accident.
 */
export function inspectorFieldRendererKind(field: FieldShapeInput): InspectorFieldRendererKind {
  const shape = field?.shape as string | undefined;
  if (shape === undefined) return legacyRendererKind(field?.type);
  switch (shape) {
    case 'scalar': return field?.type === 'string' ? 'text' : 'scalar';
    case 'boolean': return 'boolean';
    case 'enum': return 'enum';
    case 'vector': return 'vector';
    case 'quaternion': return 'quaternion';
    case 'asset-ref': return 'asset-ref';
    case 'optional': return 'optional';
    case 'nested': return 'nested';
    case 'array': return 'array';
    default: return 'unsupported';
  }
}

export function isVectorRendererKind(kind: InspectorFieldRendererKind): boolean {
  return kind === 'vector' || kind === 'quaternion';
}

export function isUnsupportedRendererKind(kind: InspectorFieldRendererKind): boolean {
  // Arrays now have the generic add/remove/reorder/update editor. Nested
  // payloads remain closed when the engine only exposes an opaque unique-ref
  // handle; do not silently send that handle through a scalar input.
  return kind === 'nested' || kind === 'unsupported';
}
