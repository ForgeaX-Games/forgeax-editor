// input-map-schema — editor-owned Input Map asset shape.
//
// Engine consumes ActionConfig[] via INPUT_MAP_KEY. The disk asset kind lives
// here as an editor/host kind (same posture as material-instance): not in the
// engine Asset union, loaded through loaders.register.
//
// Anchors: charactercontrol-input-mapping-design P0

export const INPUT_MAP_KIND = 'input-map' as const;
export const INPUT_MAP_SCHEMA_VERSION = 1 as const;

/** Mirrors @forgeax/engine-input ActionBinding (kept local to avoid a core→input hard edge). */
export type InputMapBinding =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'mouseButton'; readonly button: 0 | 1 | 2 }
  | { readonly type: 'gamepadButton'; readonly button: number }
  | { readonly type: 'gamepadAxis'; readonly axis: number; readonly sign?: 1 | -1 };

export interface InputMapAction {
  readonly action: string;
  readonly bindings: readonly InputMapBinding[];
  readonly deadzone?: number;
}

export interface InputMapPayload {
  readonly kind: typeof INPUT_MAP_KIND;
  readonly schemaVersion: typeof INPUT_MAP_SCHEMA_VERSION;
  readonly actions: readonly InputMapAction[];
}

export interface InputMapActionRow {
  readonly actionIndex: number;
  readonly action: InputMapAction;
}

export interface InputMapMappingSelection {
  readonly actionIndex: number;
  readonly bindingIndex: number;
}

export interface InputMapDiagnosticLocation {
  readonly actionIndex: number;
  readonly bindingIndex?: number;
}

type InputMapDiagnosticOf<
  Code extends string,
  Severity extends 'error' | 'warning',
> = InputMapDiagnosticLocation & {
  readonly code: Code;
  readonly severity: Severity;
  readonly message: string;
  readonly related: readonly InputMapDiagnosticLocation[];
};

export type InputMapDiagnostic =
  | InputMapDiagnosticOf<'input-map-action-name-empty', 'error'>
  | InputMapDiagnosticOf<'input-map-action-name-duplicate', 'error'>
  | InputMapDiagnosticOf<'input-map-deadzone-invalid', 'error'>
  | InputMapDiagnosticOf<'input-map-binding-duplicate', 'error'>
  | InputMapDiagnosticOf<'input-map-action-no-bindings', 'warning'>
  | InputMapDiagnosticOf<'input-map-binding-shared', 'warning'>;

const GUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID_LIKE.test(value);
}

function isBinding(value: unknown): value is InputMapBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  switch (b.type) {
    case 'key':
      return typeof b.key === 'string' && b.key.length > 0;
    case 'mouseButton':
      return b.button === 0 || b.button === 1 || b.button === 2;
    case 'gamepadButton':
      return typeof b.button === 'number' && Number.isInteger(b.button) && b.button >= 0;
    case 'gamepadAxis':
      return typeof b.axis === 'number'
        && Number.isInteger(b.axis)
        && b.axis >= 0
        && (b.sign === undefined || b.sign === 1 || b.sign === -1);
    default:
      return false;
  }
}

function isAction(value: unknown): value is InputMapAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  if (typeof a.action !== 'string' || a.action.length === 0) return false;
  if (!Array.isArray(a.bindings) || !a.bindings.every(isBinding)) return false;
  if (a.deadzone !== undefined && (typeof a.deadzone !== 'number' || !(a.deadzone >= 0) || !(a.deadzone <= 1))) {
    return false;
  }
  return true;
}

export function isInputMapPayload(value: unknown): value is InputMapPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.kind === INPUT_MAP_KIND
    && payload.schemaVersion === INPUT_MAP_SCHEMA_VERSION
    && Array.isArray(payload.actions)
    && payload.actions.every(isAction);
}

/** Default starter map: empty actions (author fills in the editor). */
export function createDefaultInputMapPayload(
  actions: readonly InputMapAction[] = [],
): InputMapPayload {
  return {
    kind: INPUT_MAP_KIND,
    schemaVersion: INPUT_MAP_SCHEMA_VERSION,
    actions: actions.map((a) => ({
      action: a.action,
      bindings: a.bindings.map((b) => ({ ...b })),
      ...(a.deadzone !== undefined ? { deadzone: a.deadzone } : {}),
    })),
  };
}

function bindingSearchText(binding: InputMapBinding): string {
  const typeWords = binding.type.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  switch (binding.type) {
    case 'key':
      return `${binding.type} ${typeWords} ${binding.key === ' ' ? 'space' : binding.key}`;
    case 'mouseButton':
    case 'gamepadButton':
      return `${binding.type} ${typeWords} ${binding.button}`;
    case 'gamepadAxis':
      return `${binding.type} ${typeWords} ${binding.axis} ${binding.sign ?? ''}`;
  }
}

/** Returns matching Actions with their stable indices in the source payload.
 * Passing diagnostics filters to Actions represented by those diagnostics;
 * omitting diagnostics leaves diagnostic visibility unrestricted. */
export function filterInputMapActions(
  payload: InputMapPayload,
  query: string,
  diagnostics?: readonly InputMapDiagnostic[],
): readonly InputMapActionRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const diagnosticActions = diagnostics === undefined
    ? undefined
    : new Set(diagnostics.map((diagnostic) => diagnostic.actionIndex));

  return payload.actions.flatMap((action, actionIndex) => {
    if (diagnosticActions !== undefined && !diagnosticActions.has(actionIndex)) return [];
    const searchText = [
      action.action,
      ...action.bindings.map(bindingSearchText),
    ].join(' ').toLowerCase();
    return normalizedQuery.length === 0 || searchText.includes(normalizedQuery)
      ? [{ actionIndex, action }]
      : [];
  });
}

/** Removes valid selected Mapping rows in one immutable edit. */
export function deleteInputMapMappings(
  payload: InputMapPayload,
  selection: readonly InputMapMappingSelection[],
): InputMapPayload {
  const selectedByAction = new Map<number, Set<number>>();
  for (const item of selection) {
    if (
      !Number.isInteger(item.actionIndex)
      || !Number.isInteger(item.bindingIndex)
      || item.actionIndex < 0
      || item.bindingIndex < 0
      || item.actionIndex >= payload.actions.length
      || item.bindingIndex >= payload.actions[item.actionIndex]!.bindings.length
    ) {
      continue;
    }
    const selected = selectedByAction.get(item.actionIndex) ?? new Set<number>();
    selected.add(item.bindingIndex);
    selectedByAction.set(item.actionIndex, selected);
  }
  if (selectedByAction.size === 0) return payload;

  return {
    ...payload,
    actions: payload.actions.map((action, actionIndex) => {
      const selected = selectedByAction.get(actionIndex);
      return selected === undefined
        ? action
        : {
          ...action,
          bindings: action.bindings.filter((_, bindingIndex) => !selected.has(bindingIndex)),
        };
    }),
  };
}

/** Appends deep-cloned Mapping rows to one valid target Action. */
export function pasteInputMapMappings(
  payload: InputMapPayload,
  actionIndex: number,
  mappings: readonly InputMapBinding[],
): InputMapPayload {
  if (
    !Number.isInteger(actionIndex)
    || actionIndex < 0
    || actionIndex >= payload.actions.length
    || mappings.length === 0
  ) {
    return payload;
  }
  const pasted = mappings.map((mapping) => ({ ...mapping }));
  return {
    ...payload,
    actions: payload.actions.map((action, index) => index === actionIndex
      ? { ...action, bindings: [...action.bindings, ...pasted] }
      : action),
  };
}

/** Moves one Action to a valid target index without changing either Action. */
export function reorderInputMapActions(
  payload: InputMapPayload,
  fromIndex: number,
  toIndex: number,
): InputMapPayload {
  if (
    !Number.isInteger(fromIndex)
    || !Number.isInteger(toIndex)
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= payload.actions.length
    || toIndex >= payload.actions.length
    || fromIndex === toIndex
  ) {
    return payload;
  }
  const actions = [...payload.actions];
  const [moved] = actions.splice(fromIndex, 1);
  actions.splice(toIndex, 0, moved!);
  return { ...payload, actions };
}

function bindingIdentity(binding: InputMapBinding): string {
  switch (binding.type) {
    case 'key':
      return `key:${binding.key}`;
    case 'mouseButton':
      return `mouseButton:${binding.button}`;
    case 'gamepadButton':
      return `gamepadButton:${binding.button}`;
    case 'gamepadAxis':
      return `gamepadAxis:${binding.axis}:${binding.sign ?? 0}`;
  }
}

function location(actionIndex: number, bindingIndex?: number): InputMapDiagnosticLocation {
  return bindingIndex === undefined ? { actionIndex } : { actionIndex, bindingIndex };
}

/** Pure editor diagnostics. The pack payload remains the only authored fact;
 * diagnostics are derived on demand and never serialized beside it. */
export function diagnoseInputMap(payload: InputMapPayload): readonly InputMapDiagnostic[] {
  const diagnostics: InputMapDiagnostic[] = [];
  const actionNames = new Map<string, number[]>();
  const bindings = new Map<string, InputMapDiagnosticLocation[]>();

  for (let actionIndex = 0; actionIndex < payload.actions.length; actionIndex += 1) {
    const action = payload.actions[actionIndex]!;
    const normalizedName = action.action.trim();
    if (normalizedName.length === 0) {
      diagnostics.push({
        code: 'input-map-action-name-empty',
        severity: 'error',
        message: 'Action name cannot be empty.',
        actionIndex,
        related: [],
      });
    } else {
      const indices = actionNames.get(normalizedName) ?? [];
      indices.push(actionIndex);
      actionNames.set(normalizedName, indices);
    }

    if (
      action.deadzone !== undefined
      && (!Number.isFinite(action.deadzone) || action.deadzone < 0 || action.deadzone > 1)
    ) {
      diagnostics.push({
        code: 'input-map-deadzone-invalid',
        severity: 'error',
        message: 'Deadzone must be a number from 0 to 1.',
        actionIndex,
        related: [],
      });
    }

    if (action.bindings.length === 0) {
      diagnostics.push({
        code: 'input-map-action-no-bindings',
        severity: 'warning',
        message: 'Action has no mappings and will never be triggered.',
        actionIndex,
        related: [],
      });
    }

    for (let bindingIndex = 0; bindingIndex < action.bindings.length; bindingIndex += 1) {
      const identity = bindingIdentity(action.bindings[bindingIndex]!);
      const locations = bindings.get(identity) ?? [];
      locations.push(location(actionIndex, bindingIndex));
      bindings.set(identity, locations);
    }
  }

  for (const [name, indices] of actionNames) {
    if (indices.length < 2) continue;
    for (const actionIndex of indices) {
      diagnostics.push({
        code: 'input-map-action-name-duplicate',
        severity: 'error',
        message: `Action name "${name}" is used more than once.`,
        actionIndex,
        related: indices.filter((index) => index !== actionIndex).map((index) => location(index)),
      });
    }
  }

  for (const locations of bindings.values()) {
    if (locations.length < 2) continue;
    for (const current of locations) {
      const sameAction = locations.filter((item) => (
        item.actionIndex === current.actionIndex && item.bindingIndex !== current.bindingIndex
      ));
      if (sameAction.length > 0) {
        diagnostics.push({
          code: 'input-map-binding-duplicate',
          severity: 'error',
          message: 'This mapping is duplicated within the same Action.',
          ...current,
          related: sameAction,
        });
      }

      const otherActions = locations.filter((item) => item.actionIndex !== current.actionIndex);
      if (otherActions.length > 0) {
        diagnostics.push({
          code: 'input-map-binding-shared',
          severity: 'warning',
          message: 'This mapping is shared by multiple Actions.',
          ...current,
          related: otherActions,
        });
      }
    }
  }

  return diagnostics.sort((a, b) => (
    a.actionIndex - b.actionIndex
    || (a.bindingIndex ?? -1) - (b.bindingIndex ?? -1)
    || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)
    || a.code.localeCompare(b.code)
  ));
}

/** Deterministically repairs blocking diagnostics without changing warning-only intent. */
export function repairInputMapErrors(payload: InputMapPayload): InputMapPayload {
  const reservedNames = new Set(
    payload.actions.map((action) => action.action.trim()).filter((name) => name.length > 0),
  );
  const usedNames = new Set<string>();

  return {
    ...payload,
    actions: payload.actions.map((action, actionIndex) => {
      const normalizedName = action.action.trim();
      const baseName = normalizedName || `action${actionIndex + 1}`;
      let actionName = baseName;
      if (
        usedNames.has(actionName)
        || (normalizedName.length === 0 && reservedNames.has(actionName))
      ) {
        let suffix = 2;
        while (reservedNames.has(`${baseName}_${suffix}`) || usedNames.has(`${baseName}_${suffix}`)) {
          suffix += 1;
        }
        actionName = `${baseName}_${suffix}`;
      }
      usedNames.add(actionName);
      reservedNames.add(actionName);

      const bindingIds = new Set<string>();
      const bindings = action.bindings.filter((binding) => {
        const identity = bindingIdentity(binding);
        if (bindingIds.has(identity)) return false;
        bindingIds.add(identity);
        return true;
      }).map((binding) => ({ ...binding }));

      const deadzone = action.deadzone === undefined || !Number.isFinite(action.deadzone)
        ? undefined
        : Math.min(1, Math.max(0, action.deadzone));

      return {
        action: actionName,
        bindings,
        ...(deadzone !== undefined ? { deadzone } : {}),
      };
    }),
  };
}

/** Project editor payload → runtime ActionConfig[] shape. */
export function toActionConfigs(payload: InputMapPayload): readonly InputMapAction[] {
  return payload.actions;
}
