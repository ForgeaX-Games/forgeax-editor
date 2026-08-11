import { describe, expect, it } from 'bun:test';
import {
  createDefaultInputMapPayload,
  deleteInputMapMappings,
  diagnoseInputMap,
  filterInputMapActions,
  isInputMapPayload,
  pasteInputMapMappings,
  repairInputMapErrors,
  reorderInputMapActions,
  toActionConfigs,
} from '../input-map-schema';

describe('input-map-schema', () => {
  it('accepts a default empty payload', () => {
    const payload = createDefaultInputMapPayload();
    expect(isInputMapPayload(payload)).toBe(true);
    expect(payload.kind).toBe('input-map');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.actions).toEqual([]);
  });

  it('round-trips actions into ActionConfig shape', () => {
    const payload = createDefaultInputMapPayload([
      {
        action: 'jump',
        bindings: [
          { type: 'key', key: ' ' },
          { type: 'gamepadButton', button: 0 },
        ],
        deadzone: 0.2,
      },
    ]);
    expect(isInputMapPayload(payload)).toBe(true);
    expect(toActionConfigs(payload)).toEqual(payload.actions);
  });

  it('rejects malformed bindings', () => {
    expect(isInputMapPayload({
      kind: 'input-map',
      schemaVersion: 1,
      actions: [{ action: 'jump', bindings: [{ type: 'key' }] }],
    })).toBe(false);
  });

  it('filters Actions by query and diagnostics while preserving source indices', () => {
    const payload = createDefaultInputMapPayload([
      { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
      { action: 'interact', bindings: [{ type: 'key', key: 'e' }] },
      { action: 'look', bindings: [{ type: 'gamepadAxis', axis: 2, sign: -1 }] },
    ]);
    const before = structuredClone(payload);
    const diagnostics = [{
      code: 'input-map-binding-shared',
      severity: 'warning',
      message: 'shared',
      actionIndex: 2,
      bindingIndex: 0,
      related: [],
    }] as const;

    expect(filterInputMapActions(payload, 'GAMEPAD axis', diagnostics)).toEqual([{
      actionIndex: 2,
      action: payload.actions[2]!,
    }]);
    expect(filterInputMapActions(payload, 'space').map((row) => row.actionIndex)).toEqual([0]);
    expect(filterInputMapActions(payload, 'INTERACT').map((row) => row.actionIndex)).toEqual([1]);
    expect(filterInputMapActions(payload, '', [])).toEqual([]);
    expect(filterInputMapActions(payload, '', [{
      ...diagnostics[0],
      actionIndex: 99,
    }])).toEqual([]);
    expect(payload).toEqual(before);
  });

  it('deletes selected Mappings once and ignores invalid indices', () => {
    const payload = createDefaultInputMapPayload([
      {
        action: 'move',
        bindings: [
          { type: 'key', key: 'w' },
          { type: 'key', key: 's' },
          { type: 'gamepadAxis', axis: 1 },
        ],
      },
      { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
    ]);
    const before = structuredClone(payload);

    const edited = deleteInputMapMappings(payload, [
      { actionIndex: 0, bindingIndex: 0 },
      { actionIndex: 0, bindingIndex: 2 },
      { actionIndex: 0, bindingIndex: 2 },
      { actionIndex: -1, bindingIndex: 0 },
      { actionIndex: 1, bindingIndex: 99 },
    ]);

    expect(edited.actions[0]?.bindings).toEqual([{ type: 'key', key: 's' }]);
    expect(edited.actions[1]).toBe(payload.actions[1]);
    expect(payload).toEqual(before);
    expect(deleteInputMapMappings(payload, [
      { actionIndex: 99, bindingIndex: 0 },
    ])).toBe(payload);
  });

  it('pastes deep-cloned Mappings into one valid Action', () => {
    const payload = createDefaultInputMapPayload([
      { action: 'primary', bindings: [{ type: 'mouseButton', button: 0 }] },
      { action: 'secondary', bindings: [] },
    ]);
    const mappings = [
      { type: 'key', key: 'e' },
      { type: 'gamepadAxis', axis: 2, sign: -1 },
    ] as const;
    const before = structuredClone(payload);

    const edited = pasteInputMapMappings(payload, 1, mappings);

    expect(edited.actions[1]?.bindings).toEqual(mappings);
    expect(edited.actions[1]?.bindings[0]).not.toBe(mappings[0]);
    expect(edited.actions[1]?.bindings[1]).not.toBe(mappings[1]);
    expect(edited.actions[0]).toBe(payload.actions[0]);
    expect(payload).toEqual(before);
    expect(pasteInputMapMappings(payload, -1, mappings)).toBe(payload);
    expect(pasteInputMapMappings(payload, 2, mappings)).toBe(payload);
    expect(pasteInputMapMappings(payload, 0, [])).toBe(payload);
  });

  it('reorders Actions immutably and treats invalid moves as no-ops', () => {
    const payload = createDefaultInputMapPayload([
      { action: 'first', bindings: [] },
      { action: 'second', bindings: [] },
      { action: 'third', bindings: [] },
    ]);
    const before = structuredClone(payload);

    const edited = reorderInputMapActions(payload, 0, 2);

    expect(edited.actions.map((action) => action.action)).toEqual(['second', 'third', 'first']);
    expect(edited.actions[2]).toBe(payload.actions[0]);
    expect(payload).toEqual(before);
    expect(reorderInputMapActions(payload, 0, 0)).toBe(payload);
    expect(reorderInputMapActions(payload, -1, 0)).toBe(payload);
    expect(reorderInputMapActions(payload, 0, 3)).toBe(payload);
    expect(reorderInputMapActions(payload, 0.5, 1)).toBe(payload);
  });

  it('diagnoses invalid Action fields without mutating the payload', () => {
    const payload = createDefaultInputMapPayload([
      { action: '   ', bindings: [], deadzone: 2 },
      { action: 'jump', bindings: [] },
      { action: ' jump ', bindings: [{ type: 'key', key: ' ' }] },
    ]);
    const before = structuredClone(payload);

    expect(diagnoseInputMap(payload).map(({ code, severity, actionIndex }) => ({
      code,
      severity,
      actionIndex,
    }))).toEqual([
      { code: 'input-map-action-name-empty', severity: 'error', actionIndex: 0 },
      { code: 'input-map-deadzone-invalid', severity: 'error', actionIndex: 0 },
      { code: 'input-map-action-no-bindings', severity: 'warning', actionIndex: 0 },
      { code: 'input-map-action-name-duplicate', severity: 'error', actionIndex: 1 },
      { code: 'input-map-action-no-bindings', severity: 'warning', actionIndex: 1 },
      { code: 'input-map-action-name-duplicate', severity: 'error', actionIndex: 2 },
    ]);
    expect(payload).toEqual(before);
  });

  it('diagnoses exact duplicate bindings within one Action', () => {
    const bindings = [
      { type: 'key', key: 'e' },
      { type: 'mouseButton', button: 1 },
      { type: 'gamepadButton', button: 3 },
      { type: 'gamepadAxis', axis: 0, sign: -1 },
    ] as const;
    const payload = createDefaultInputMapPayload([{
      action: 'move',
      bindings: bindings.flatMap((binding) => [binding, binding]),
    }]);

    const duplicates = diagnoseInputMap(payload).filter(
      (diagnostic) => diagnostic.code === 'input-map-binding-duplicate',
    );
    expect(duplicates).toHaveLength(8);
    expect(duplicates.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(duplicates.every((diagnostic) => diagnostic.related.length === 1)).toBe(true);
  });

  it('warns when keyboard, mouse, and gamepad bindings are shared across Actions', () => {
    const bindings = [
      { type: 'key', key: 'e' },
      { type: 'mouseButton', button: 0 },
      { type: 'gamepadButton', button: 1 },
      { type: 'gamepadAxis', axis: 2, sign: 1 },
    ] as const;
    const payload = createDefaultInputMapPayload([
      { action: 'primary', bindings },
      { action: 'secondary', bindings },
    ]);

    const diagnostics = diagnoseInputMap(payload);
    expect(diagnostics).toHaveLength(8);
    expect(diagnostics.every(
      (diagnostic) => diagnostic.code === 'input-map-binding-shared',
    )).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
  });

  it('keeps same-Action duplicates as errors when another Action also shares the binding', () => {
    const payload = createDefaultInputMapPayload([
      {
        action: 'primary',
        bindings: [
          { type: 'key', key: 'e' },
          { type: 'key', key: 'e' },
        ],
      },
      { action: 'secondary', bindings: [{ type: 'key', key: 'e' }] },
    ]);

    const diagnostics = diagnoseInputMap(payload);
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'input-map-binding-duplicate',
    )).toHaveLength(2);
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'input-map-binding-shared',
    )).toHaveLength(3);
  });

  it('treats gamepad axis sign as part of the binding identity', () => {
    const payload = createDefaultInputMapPayload([{
      action: 'move',
      bindings: [
        { type: 'gamepadAxis', axis: 0, sign: -1 },
        { type: 'gamepadAxis', axis: 0, sign: 1 },
        { type: 'gamepadAxis', axis: 0 },
      ],
    }]);

    expect(diagnoseInputMap(payload)).toEqual([]);
  });

  it('repairs names, deadzones, and exact binding duplicates deterministically', () => {
    const payload = createDefaultInputMapPayload([
      {
        action: '  ',
        bindings: [
          { type: 'key', key: 'e' },
          { type: 'key', key: 'e' },
        ],
        deadzone: 2,
      },
      {
        action: 'action1',
        bindings: [
          { type: 'mouseButton', button: 0 },
          { type: 'mouseButton', button: 0 },
        ],
      },
      {
        action: 'jump',
        bindings: [
          { type: 'gamepadButton', button: 1 },
          { type: 'gamepadButton', button: 1 },
        ],
      },
      {
        action: ' jump ',
        bindings: [
          { type: 'gamepadAxis', axis: 2, sign: 1 },
          { type: 'gamepadAxis', axis: 2, sign: 1 },
        ],
        deadzone: -0.5,
      },
      { action: 'jump_2', bindings: [{ type: 'key', key: 'e' }] },
      { action: 'look', bindings: [{ type: 'gamepadAxis', axis: 0 }], deadzone: Number.NaN },
    ]);
    const before = structuredClone(payload);

    const repaired = repairInputMapErrors(payload);

    expect(repaired.actions.map((action) => action.action)).toEqual([
      'action1_2',
      'action1',
      'jump',
      'jump_3',
      'jump_2',
      'look',
    ]);
    expect(repaired.actions[0]?.bindings).toEqual([{ type: 'key', key: 'e' }]);
    expect(repaired.actions[0]?.deadzone).toBe(1);
    expect(repaired.actions[1]?.bindings).toEqual([{ type: 'mouseButton', button: 0 }]);
    expect(repaired.actions[2]?.bindings).toEqual([{ type: 'gamepadButton', button: 1 }]);
    expect(repaired.actions[3]?.bindings).toEqual([
      { type: 'gamepadAxis', axis: 2, sign: 1 },
    ]);
    expect(repaired.actions[3]?.deadzone).toBe(0);
    expect(repaired.actions[5]?.deadzone).toBeUndefined();
    expect(diagnoseInputMap(repaired).filter(
      (diagnostic) => diagnostic.severity === 'error',
    )).toEqual([]);
    expect(payload).toEqual(before);
    expect(repairInputMapErrors(repaired)).toEqual(repaired);
  });

  it('preserves warning-only cross-Action binding reuse', () => {
    const payload = createDefaultInputMapPayload([
      { action: 'interact', bindings: [{ type: 'key', key: 'e' }] },
      { action: 'enterVehicle', bindings: [{ type: 'key', key: 'e' }] },
    ]);

    const repaired = repairInputMapErrors(payload);

    expect(repaired.actions[0]?.bindings).toEqual([{ type: 'key', key: 'e' }]);
    expect(repaired.actions[1]?.bindings).toEqual([{ type: 'key', key: 'e' }]);
    expect(diagnoseInputMap(repaired).every(
      (diagnostic) => diagnostic.code === 'input-map-binding-shared',
    )).toBe(true);
  });
});
