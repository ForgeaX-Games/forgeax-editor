// InputMapEditor — Input Map properties panel (staging + action/binding rows).
//
// Visual posture: UE Enhanced Input / IMC Details — Mapping Context header,
// Action rows, nested Mappings. Binding values use listen-to-bind (click slot →
// press key / mouse / gamepad), not free-text numeric entry.
// Edits go through updateInputMapStaging; Ctrl+S flushes via PageController.save.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  diagnoseInputMap,
  deleteInputMapMappings,
  filterInputMapActions,
  getInputMapStaging,
  isInputMapStagingDirty,
  isInputMapPayload,
  keepInputMapStaging,
  openInputMapStaging,
  pasteInputMapMappings,
  repairInputMapErrors,
  reorderInputMapActions,
  reloadInputMapStaging,
  subscribeInputMapStaging,
  trySaveActivePage,
  updateInputMapStaging,
  useActiveEditorAsset,
  type InputMapAction,
  type InputMapBinding,
  type InputMapDiagnostic,
  type InputMapDiagnosticLocation,
  type InputMapPayload,
} from '@forgeax/editor-core';
import { confirm, toast } from '@forgeax/editor-ui';
import './input-map-editor.css';

// Keys must NOT include editable field values. Including `row.action` remounts
// the row on every Backspace, blurs the input, then the next Delete falls
// through to the global CB "delete assets folder" shortcut.

type ListeningSlot = {
  readonly actionIndex: number;
  readonly bindingIndex: number;
  readonly kind: InputMapBinding['type'];
};

type DiagnosticFilter = 'all' | 'errors' | 'warnings' | 'shared';

type MappingClipboard = {
  readonly kind: 'forgeax-input-map-bindings';
  readonly bindings: readonly InputMapBinding[];
};

const VIRTUALIZE_ACTION_THRESHOLD = 50;

export function parseInputMapJson(text: string): InputMapPayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isInputMapPayload(parsed) ? structuredClone(parsed) : null;
  } catch {
    return null;
  }
}

export function serializeInputMapJson(payload: InputMapPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

const MOUSE_BUTTONS: ReadonlyArray<{ value: 0 | 1 | 2; label: string }> = [
  { value: 0, label: 'Left Mouse Button' },
  { value: 1, label: 'Middle Mouse Button' },
  { value: 2, label: 'Right Mouse Button' },
];

/** W3C Standard Gamepad button indices — labels mirror UE / common pads. */
const GAMEPAD_BUTTONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Gamepad Face Button Bottom (A / Cross)' },
  { value: 1, label: 'Gamepad Face Button Right (B / Circle)' },
  { value: 2, label: 'Gamepad Face Button Left (X / Square)' },
  { value: 3, label: 'Gamepad Face Button Top (Y / Triangle)' },
  { value: 4, label: 'Gamepad Left Shoulder (LB)' },
  { value: 5, label: 'Gamepad Right Shoulder (RB)' },
  { value: 6, label: 'Gamepad Left Trigger (LT)' },
  { value: 7, label: 'Gamepad Right Trigger (RT)' },
  { value: 8, label: 'Gamepad Special Left (Back / Select)' },
  { value: 9, label: 'Gamepad Special Right (Start)' },
  { value: 10, label: 'Gamepad Left Thumbstick Button (L3)' },
  { value: 11, label: 'Gamepad Right Thumbstick Button (R3)' },
  { value: 12, label: 'Gamepad D-Pad Up' },
  { value: 13, label: 'Gamepad D-Pad Down' },
  { value: 14, label: 'Gamepad D-Pad Left' },
  { value: 15, label: 'Gamepad D-Pad Right' },
];

const GAMEPAD_AXES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Gamepad Left Stick X' },
  { value: 1, label: 'Gamepad Left Stick Y' },
  { value: 2, label: 'Gamepad Right Stick X' },
  { value: 3, label: 'Gamepad Right Stick Y' },
];

function formatKeyLabel(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'Escape') return 'Escape';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function mouseLabel(button: 0 | 1 | 2): string {
  return MOUSE_BUTTONS.find((m) => m.value === button)?.label ?? `Mouse ${button}`;
}

function gamepadButtonLabel(button: number): string {
  return GAMEPAD_BUTTONS.find((b) => b.value === button)?.label ?? `Gamepad Button ${button}`;
}

function gamepadAxisLabel(axis: number, sign: 1 | -1 | undefined): string {
  const base = GAMEPAD_AXES.find((a) => a.value === axis)?.label ?? `Gamepad Axis ${axis}`;
  if (sign === -1) return `${base} (−)`;
  if (sign === 1) return `${base} (+)`;
  return base;
}

function bindingDisplay(b: InputMapBinding): string {
  switch (b.type) {
    case 'key':
      return formatKeyLabel(b.key);
    case 'mouseButton':
      return mouseLabel(b.button);
    case 'gamepadButton':
      return gamepadButtonLabel(b.button);
    case 'gamepadAxis':
      return gamepadAxisLabel(b.axis, b.sign);
  }
}

function listenPrompt(kind: InputMapBinding['type']): string {
  switch (kind) {
    case 'key':
      return 'Press any key…';
    case 'mouseButton':
      return 'Click a mouse button…';
    case 'gamepadButton':
      return 'Press a gamepad button…';
    case 'gamepadAxis':
      return 'Move a stick / axis…';
  }
}

function defaultBinding(type: InputMapBinding['type']): InputMapBinding {
  switch (type) {
    case 'key':
      return { type: 'key', key: 'w' };
    case 'mouseButton':
      return { type: 'mouseButton', button: 0 };
    case 'gamepadButton':
      return { type: 'gamepadButton', button: 0 };
    case 'gamepadAxis':
      return { type: 'gamepadAxis', axis: 0, sign: 1 };
  }
}

/** UE-style bind slot: click to listen, or pick from named lists for mouse/pad. */
function BindingValueSlot(props: {
  binding: InputMapBinding;
  listening: boolean;
  onStartListen: () => void;
  onCancelListen: () => void;
  onCommit: (next: InputMapBinding) => void;
}): ReactElement {
  const { binding, listening, onStartListen, onCancelListen, onCommit } = props;

  return (
    <div className="im-map__value-wrap">
      <button
        type="button"
        className="im-bind"
        data-listening={listening ? '1' : '0'}
        data-testid="input-map-bind-slot"
        onClick={() => (listening ? onCancelListen() : onStartListen())}
        title={listening ? 'Click or press Escape to cancel' : 'Click, then press the input to bind'}
      >
        {listening ? listenPrompt(binding.type) : bindingDisplay(binding)}
      </button>

      {!listening && binding.type === 'mouseButton' ? (
        <select
          className="im-map__picker"
          value={binding.button}
          aria-label="Mouse button"
          onChange={(e) => onCommit({
            type: 'mouseButton',
            button: Number(e.target.value) as 0 | 1 | 2,
          })}
        >
          {MOUSE_BUTTONS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      ) : null}

      {!listening && binding.type === 'gamepadButton' ? (
        <select
          className="im-map__picker"
          value={binding.button}
          aria-label="Gamepad button"
          onChange={(e) => onCommit({
            type: 'gamepadButton',
            button: Number(e.target.value),
          })}
        >
          {GAMEPAD_BUTTONS.map((b) => (
            <option key={b.value} value={b.value}>{b.label}</option>
          ))}
          {!GAMEPAD_BUTTONS.some((b) => b.value === binding.button) ? (
            <option value={binding.button}>Gamepad Button {binding.button}</option>
          ) : null}
        </select>
      ) : null}

      {!listening && binding.type === 'gamepadAxis' ? (
        <div className="im-map__axis">
          <select
            className="im-map__picker"
            value={binding.axis}
            aria-label="Gamepad axis"
            onChange={(e) => onCommit({
              type: 'gamepadAxis',
              axis: Number(e.target.value),
              sign: binding.sign ?? 1,
            })}
          >
            {GAMEPAD_AXES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
            {!GAMEPAD_AXES.some((a) => a.value === binding.axis) ? (
              <option value={binding.axis}>Gamepad Axis {binding.axis}</option>
            ) : null}
          </select>
          <select
            className="im-map__sign"
            value={binding.sign ?? 1}
            aria-label="Axis sign"
            onChange={(e) => onCommit({
              type: 'gamepadAxis',
              axis: binding.axis,
              sign: Number(e.target.value) as 1 | -1,
            })}
          >
            <option value={1}>+ Scale</option>
            <option value={-1}>− Scale</option>
          </select>
        </div>
      ) : null}
    </div>
  );
}

export function InputMapEditor(): ReactElement {
  const asset = useActiveEditorAsset();
  const editorRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const mappingClipboardRef = useRef<MappingClipboard | null>(null);
  const [version, setVersion] = useState(0);
  const [listening, setListening] = useState<ListeningSlot | null>(null);
  const [query, setQuery] = useState('');
  const [diagnosticFilter, setDiagnosticFilter] = useState<DiagnosticFilter>('all');
  const [collapsedActions, setCollapsedActions] = useState<ReadonlySet<number>>(() => new Set());
  const [selectedMappings, setSelectedMappings] = useState<ReadonlySet<string>>(() => new Set());
  const [draggingAction, setDraggingAction] = useState<number | null>(null);
  const [dropTargetAction, setDropTargetAction] = useState<number | null>(null);

  useEffect(() => subscribeInputMapStaging(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    if (!asset || asset.kind !== 'input-map') return;
    openInputMapStaging({
      guid: asset.guid,
      packPath: asset.packPath,
      name: asset.name,
      payload: asset.payload,
    });
  }, [asset?.guid, asset?.packPath, asset?.name, asset?.kind, asset?.payload]);
  useEffect(() => {
    setQuery('');
    setDiagnosticFilter('all');
    setCollapsedActions(new Set());
    setSelectedMappings(new Set());
    setListening(null);
  }, [asset?.guid]);

  const entry = useMemo(() => {
    void version;
    return asset?.guid ? getInputMapStaging(asset.guid) : undefined;
  }, [asset?.guid, version]);

  const dirty = asset?.guid ? isInputMapStagingDirty(asset.guid) : false;
  const payload: InputMapPayload | undefined = entry?.staging;
  const external = entry?.external;
  const guid = asset?.guid;
  const diagnostics = useMemo(
    () => (payload ? diagnoseInputMap(payload) : []),
    [payload],
  );
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.length - errorCount;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleActionIndices = useMemo(() => {
    if (!payload) return [];
    const filteredDiagnostics = diagnosticFilter === 'all'
      ? undefined
      : diagnostics.filter((diagnostic) => (
        diagnosticFilter === 'errors'
          ? diagnostic.severity === 'error'
          : diagnosticFilter === 'warnings'
            ? diagnostic.severity === 'warning'
            : diagnostic.code === 'input-map-binding-shared'
      ));
    return filterInputMapActions(payload, normalizedQuery, filteredDiagnostics)
      .map((row) => row.actionIndex);
  }, [diagnosticFilter, diagnostics, normalizedQuery, payload]);
  const forceExpanded = normalizedQuery.length > 0 || diagnosticFilter !== 'all';
  const virtualized = visibleActionIndices.length >= VIRTUALIZE_ACTION_THRESHOLD;
  const actionVirtualizer = useVirtualizer({
    count: virtualized ? visibleActionIndices.length : 0,
    getScrollElement: () => bodyRef.current,
    estimateSize: (visibleIndex) => {
      const actionIndex = visibleActionIndices[visibleIndex];
      return actionIndex !== undefined && !forceExpanded && collapsedActions.has(actionIndex) ? 54 : 190;
    },
    overscan: 5,
  });

  const commitListening = useCallback((next: InputMapBinding) => {
    if (!guid || !listening) return;
    updateInputMapStaging(guid, (prev) => ({
      ...prev,
      actions: prev.actions.map((row, i) => {
        if (i !== listening.actionIndex) return row;
        return {
          ...row,
          bindings: row.bindings.map((b, bi) => (bi === listening.bindingIndex ? next : b)),
        };
      }),
    }));
    setListening(null);
  }, [guid, listening]);

  // Listen-to-bind capture (UE IMC: click slot → press hardware). Keyboard stays
  // on the editor root; mouse/gamepad need temporary hardware listeners.
  useEffect(() => {
    if (!listening || !guid) return;

    const onMouseDown = (e: MouseEvent) => {
      if (listening.kind !== 'mouseButton') return;
      // Ignore clicks on the bind slot itself (cancel / re-arm).
      const t = e.target;
      if (t instanceof Element && t.closest('[data-testid="input-map-bind-slot"]')) return;
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      commitListening({ type: 'mouseButton', button: e.button as 0 | 1 | 2 });
    };

    const onContextMenu = (e: Event) => {
      if (listening.kind === 'mouseButton') {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Snapshot current pad state so we only accept rising edges / new deflection.
    const padBaseline = new Map<number, { buttons: boolean[]; axes: number[] }>();
    const snapshotPads = () => {
      const pads = navigator.getGamepads?.() ?? [];
      for (const pad of pads) {
        if (!pad) continue;
        padBaseline.set(pad.index, {
          buttons: pad.buttons.map((b) => b.pressed || b.value > 0.5),
          axes: [...pad.axes],
        });
      }
    };
    snapshotPads();

    let raf = 0;
    const pollGamepad = () => {
      const pads = navigator.getGamepads?.() ?? [];
      for (const pad of pads) {
        if (!pad) continue;
        const base = padBaseline.get(pad.index) ?? {
          buttons: pad.buttons.map(() => false),
          axes: pad.axes.map(() => 0),
        };
        if (listening.kind === 'gamepadButton') {
          for (let i = 0; i < pad.buttons.length; i += 1) {
            const pressed = pad.buttons[i]!.pressed || pad.buttons[i]!.value > 0.5;
            if (pressed && !base.buttons[i]) {
              commitListening({ type: 'gamepadButton', button: i });
              return;
            }
          }
        }
        if (listening.kind === 'gamepadAxis') {
          for (let i = 0; i < pad.axes.length; i += 1) {
            const v = pad.axes[i] ?? 0;
            const prev = base.axes[i] ?? 0;
            if (Math.abs(v) >= 0.55 && Math.abs(v) > Math.abs(prev) + 0.2) {
              commitListening({
                type: 'gamepadAxis',
                axis: i,
                sign: v >= 0 ? 1 : -1,
              });
              return;
            }
          }
        }
        padBaseline.set(pad.index, {
          buttons: pad.buttons.map((b) => b.pressed || b.value > 0.5),
          axes: [...pad.axes],
        });
      }
      raf = window.requestAnimationFrame(pollGamepad);
    };

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    if (listening.kind === 'gamepadButton' || listening.kind === 'gamepadAxis') {
      raf = window.requestAnimationFrame(pollGamepad);
    }

    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [listening, guid, commitListening]);

  if (!guid || !payload || asset?.kind !== 'input-map') {
    return (
      <div className="im-editor" data-testid="input-map-editor">
        <div className="im-editor__empty">Select an Input Map asset to edit bindings.</div>
      </div>
    );
  }

  const patchActions = (actions: readonly InputMapAction[]) => {
    updateInputMapStaging(guid, (prev) => ({ ...prev, actions }));
  };

  const addAction = () => {
    const actionIndex = payload.actions.length;
    patchActions([
      ...payload.actions,
      { action: `action${actionIndex + 1}`, bindings: [defaultBinding('key')] },
    ]);
    setListening({ actionIndex, bindingIndex: 0, kind: 'key' });
  };

  const removeAction = (index: number) => {
    setListening(null);
    patchActions(payload.actions.filter((_, i) => i !== index));
  };

  const renameAction = (index: number, action: string) => {
    patchActions(payload.actions.map((row, i) => (i === index ? { ...row, action } : row)));
  };

  const setDeadzone = (index: number, deadzone: number | undefined) => {
    patchActions(payload.actions.map((row, i) => {
      if (i !== index) return row;
      if (deadzone === undefined) {
        const { deadzone: _drop, ...rest } = row;
        return rest;
      }
      return { ...row, deadzone };
    }));
  };

  const addBinding = (actionIndex: number) => {
    const bindingIndex = payload.actions[actionIndex]?.bindings.length ?? 0;
    patchActions(payload.actions.map((row, i) => (
      i === actionIndex
        ? { ...row, bindings: [...row.bindings, defaultBinding('key')] }
        : row
    )));
    setListening({ actionIndex, bindingIndex, kind: 'key' });
  };

  const removeBinding = (actionIndex: number, bindingIndex: number) => {
    setListening(null);
    patchActions(payload.actions.map((row, i) => (
      i === actionIndex
        ? { ...row, bindings: row.bindings.filter((_, bi) => bi !== bindingIndex) }
        : row
    )));
  };

  const mappingKey = (actionIndex: number, bindingIndex: number) => `${actionIndex}:${bindingIndex}`;

  const toggleMappingSelection = (actionIndex: number, bindingIndex: number) => {
    const key = mappingKey(actionIndex, bindingIndex);
    setSelectedMappings((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedBindingValues = (): InputMapBinding[] => {
    const values: InputMapBinding[] = [];
    payload.actions.forEach((row, actionIndex) => {
      row.bindings.forEach((binding, bindingIndex) => {
        if (selectedMappings.has(mappingKey(actionIndex, bindingIndex))) {
          values.push(structuredClone(binding));
        }
      });
    });
    return values;
  };

  const copySelectedMappings = async () => {
    const bindings = selectedBindingValues();
    if (bindings.length === 0) return;
    const clipboard: MappingClipboard = {
      kind: 'forgeax-input-map-bindings',
      bindings,
    };
    mappingClipboardRef.current = clipboard;
    try {
      await navigator.clipboard?.writeText(JSON.stringify(clipboard));
      toast.success(`Copied ${bindings.length} mapping${bindings.length === 1 ? '' : 's'}`);
    } catch {
      toast.info(`Copied ${bindings.length} mapping${bindings.length === 1 ? '' : 's'} inside the editor`);
    }
  };

  const readMappingClipboard = async (): Promise<MappingClipboard | null> => {
    let candidate: unknown = mappingClipboardRef.current;
    try {
      const text = await navigator.clipboard?.readText();
      if (text) candidate = JSON.parse(text);
    } catch {
      // Browser clipboard permission is optional; the in-editor copy remains usable.
    }
    if (!candidate || typeof candidate !== 'object') return null;
    const value = candidate as { kind?: unknown; bindings?: unknown };
    if (value.kind !== 'forgeax-input-map-bindings' || !Array.isArray(value.bindings)) return null;
    const probe: InputMapPayload = {
      kind: payload.kind,
      schemaVersion: payload.schemaVersion,
      actions: [{ action: 'clipboard', bindings: value.bindings as InputMapBinding[] }],
    };
    return isInputMapPayload(probe)
      ? { kind: 'forgeax-input-map-bindings', bindings: structuredClone(probe.actions[0]!.bindings) }
      : null;
  };

  const pasteMappings = async (actionIndex: number) => {
    const clipboard = await readMappingClipboard();
    if (!clipboard || clipboard.bindings.length === 0) {
      toast.error('Clipboard does not contain ForgeaX Input Map mappings');
      return;
    }
    updateInputMapStaging(guid, (current) => (
      pasteInputMapMappings(current, actionIndex, clipboard.bindings)
    ));
    toast.success(`Pasted ${clipboard.bindings.length} mapping${clipboard.bindings.length === 1 ? '' : 's'}`);
  };

  const deleteSelectedMappings = () => {
    if (selectedMappings.size === 0) return;
    const selection = [...selectedMappings].map((key) => {
      const [actionIndex, bindingIndex] = key.split(':').map(Number);
      return { actionIndex: actionIndex!, bindingIndex: bindingIndex! };
    });
    updateInputMapStaging(guid, (current) => deleteInputMapMappings(current, selection));
    setListening(null);
    setSelectedMappings(new Set());
  };

  const reorderAction = (fromIndex: number, toIndex: number) => {
    updateInputMapStaging(guid, (current) => reorderInputMapActions(current, fromIndex, toIndex));
    setListening(null);
    setSelectedMappings(new Set());
    setCollapsedActions(new Set());
  };

  const importJson = async (file: File) => {
    try {
      const parsed = parseInputMapJson(await file.text());
      if (!parsed) {
        toast.error('Invalid Input Map JSON', {
          description: 'Expected an InputMapPayload with valid actions and mappings.',
        });
        return;
      }
      if (dirty) {
        const accepted = await confirm({
          title: 'Replace unsaved Input Map edits?',
          description: 'Import replaces the current staging content. You can still close without saving to restore the disk version.',
          confirmText: 'Replace Staging',
          cancelText: 'Cancel',
          destructive: true,
        });
        if (!accepted) return;
      }
      updateInputMapStaging(guid, () => parsed);
      setListening(null);
      setSelectedMappings(new Set());
      setCollapsedActions(new Set());
      toast.success(`Imported ${file.name}`);
    } catch (cause) {
      toast.error('Could not import Input Map JSON', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const exportJson = () => {
    const blob = new Blob([serializeInputMapJson(payload)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${entry?.name ?? 'InputMap'}.input-map.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${entry?.name ?? 'Input Map'}`);
  };

  const replaceBinding = (
    actionIndex: number,
    bindingIndex: number,
    next: InputMapBinding,
  ) => {
    patchActions(payload.actions.map((row, i) => {
      if (i !== actionIndex) return row;
      return {
        ...row,
        bindings: row.bindings.map((b, bi) => (bi === bindingIndex ? next : b)),
      };
    }));
  };

  const setBindingType = (
    actionIndex: number,
    bindingIndex: number,
    type: InputMapBinding['type'],
  ) => {
    replaceBinding(actionIndex, bindingIndex, defaultBinding(type));
    setListening({ actionIndex, bindingIndex, kind: type });
  };

  const isListening = (actionIndex: number, bindingIndex: number) => (
    listening?.actionIndex === actionIndex && listening.bindingIndex === bindingIndex
  );

  const focusLocation = (location: InputMapDiagnosticLocation) => {
    setQuery('');
    setDiagnosticFilter('all');
    setCollapsedActions((current) => {
      if (!current.has(location.actionIndex)) return current;
      const next = new Set(current);
      next.delete(location.actionIndex);
      return next;
    });
    if (payload.actions.length >= VIRTUALIZE_ACTION_THRESHOLD) {
      actionVirtualizer.scrollToIndex(location.actionIndex, { align: 'center' });
    }
    const selector = location.bindingIndex === undefined
      ? `[data-im-action="${location.actionIndex}"]`
      : `[data-im-location="${location.actionIndex}:${location.bindingIndex}"]`;
    requestAnimationFrame(() => {
      const target = editorRef.current?.querySelector<HTMLElement>(selector);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.querySelector<HTMLElement>('input, select, button')?.focus();
    });
  };

  const repairAllErrors = () => {
    setListening(null);
    updateInputMapStaging(guid, repairInputMapErrors);
  };

  const reloadExternal = async () => {
    const accepted = await confirm({
      title: 'Reload Input Map from disk?',
      description: 'Your unsaved Input Map edits will be discarded.',
      confirmText: 'Reload from Disk',
      cancelText: 'Keep Editing',
      destructive: true,
    });
    if (!accepted) return;
    setListening(null);
    reloadInputMapStaging(guid);
  };

  const keepLocal = () => {
    keepInputMapStaging(guid);
  };

  return (
    <div
      ref={editorRef}
      className="im-editor"
      data-testid="input-map-editor"
      data-listening={listening ? '1' : '0'}
      onKeyDownCapture={(e) => {
        if (!listening) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          setListening(null);
          return;
        }
        if (listening.kind !== 'key' || e.repeat) return;
        // Ignore pure modifiers as the sole binding (UE also waits for a real key).
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
        commitListening({ type: 'key', key: e.key });
      }}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        const typing = target.matches('input:not([type="checkbox"]), textarea, select')
          || target.isContentEditable;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'c' && selectedMappings.size > 0 && !typing) {
          e.preventDefault();
          e.stopPropagation();
          void copySelectedMappings();
          return;
        }
        if ((e.key === 'Backspace' || e.key === 'Delete')) {
          e.stopPropagation();
          if (selectedMappings.size > 0 && !typing) {
            e.preventDefault();
            deleteSelectedMappings();
          }
        }
      }}
    >
      <div className="im-editor__head">
        <div className="im-editor__title">Input Mapping Context</div>
        <div className="im-editor__meta" data-dirty={dirty ? '1' : '0'}>
          {payload.actions.length} actions{dirty ? ' · unsaved' : ''}
          {listening ? ' · listening' : ''}
          {diagnostics.length === 0
            ? ' · valid'
            : ` · ${errorCount} errors · ${warningCount} warnings`}
        </div>
        <div className="im-editor__spacer" />
        <button
          type="button"
          className="im-btn"
          disabled={!dirty || entry?.saveStatus === 'saving'}
          onClick={() => { void trySaveActivePage(); }}
          data-testid="input-map-save"
        >
          {entry?.saveStatus === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="im-btn im-btn--primary"
          onClick={addAction}
          data-testid="input-map-add-action"
        >
          + Action
        </button>
      </div>

      <div className="im-editor__toolbar">
        <input
          className="im-editor__search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search actions or mappings"
          aria-label="Search Input Map"
          data-testid="input-map-search"
        />
        <div className="im-editor__filters" aria-label="Diagnostic filters">
          {([
            ['all', 'All'],
            ['errors', 'Errors'],
            ['warnings', 'Warnings'],
            ['shared', 'Shared'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="im-btn im-filter"
              data-active={diagnosticFilter === value ? '1' : '0'}
              onClick={() => setDiagnosticFilter(value)}
              data-testid={`input-map-filter-${value}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="im-editor__transfer">
          <input
            ref={importRef}
            type="file"
            accept=".json,.input-map.json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importJson(file);
            }}
            data-testid="input-map-import-file"
          />
          <button type="button" className="im-btn" onClick={() => importRef.current?.click()}>
            Import JSON
          </button>
          <button type="button" className="im-btn" onClick={exportJson}>
            Export JSON
          </button>
        </div>
        {selectedMappings.size > 0 ? (
          <div className="im-selection-actions" data-testid="input-map-selection-actions">
            <span>{selectedMappings.size} selected</span>
            <button type="button" className="im-btn" onClick={() => { void copySelectedMappings(); }}>
              Copy
            </button>
            <button type="button" className="im-btn im-btn--danger" onClick={deleteSelectedMappings}>
              Delete Selected
            </button>
            <button type="button" className="im-btn" onClick={() => setSelectedMappings(new Set())}>
              Clear
            </button>
          </div>
        ) : null}
      </div>

      {external ? (
        <div className="im-external-conflict" role="alert" data-testid="input-map-external-conflict">
          <div className="im-external-conflict__copy">
            <strong>Changed on disk</strong>
            <span>
              Another tool modified this Input Map. Reload discards your unsaved edits;
              Keep Mine preserves them for the next save.
            </span>
          </div>
          <div className="im-external-conflict__actions">
            <button type="button" className="im-btn" onClick={keepLocal}>
              Keep Mine
            </button>
            <button
              type="button"
              className="im-btn im-btn--danger"
              onClick={() => { void reloadExternal(); }}
            >
              Reload from Disk
            </button>
          </div>
        </div>
      ) : null}

      {diagnostics.length > 0 ? (
        <div className="im-diagnostics" role="status" data-testid="input-map-diagnostics">
          <div className="im-diagnostics__summary-row">
            <div className="im-diagnostics__summary">
              {errorCount > 0 ? `${errorCount} errors` : 'No errors'}
              {` · ${warningCount} warnings`}
              {errorCount > 0 ? ' · fix errors before saving' : ''}
            </div>
            {errorCount > 0 ? (
              <button
                type="button"
                className="im-btn im-btn--fix"
                data-testid="input-map-fix-errors"
                onClick={repairAllErrors}
              >
                Fix all errors
              </button>
            ) : null}
          </div>
          <div className="im-diagnostics__items">
            {diagnostics.map((diagnostic, index) => (
              <div
                key={`${diagnostic.code}-${diagnostic.actionIndex}-${diagnostic.bindingIndex ?? 'action'}-${index}`}
                className="im-diagnostic"
                data-severity={diagnostic.severity}
              >
                <button
                  type="button"
                  className="im-diagnostic__main"
                  onClick={() => focusLocation(diagnostic)}
                >
                  <span>{diagnostic.severity === 'error' ? 'Error' : 'Warning'}</span>
                  {` · Action ${diagnostic.actionIndex + 1}`}
                  {diagnostic.bindingIndex === undefined
                    ? ''
                    : ` · Mapping ${diagnostic.bindingIndex + 1}`}
                  {` · ${diagnostic.message}`}
                </button>
                {diagnostic.related.length > 0 ? (
                  <div className="im-diagnostic__related">
                    <span>Related:</span>
                    {diagnostic.related.map((related) => (
                      <button
                        key={`${related.actionIndex}:${related.bindingIndex ?? 'action'}`}
                        type="button"
                        onClick={() => focusLocation(related)}
                      >
                        Action {related.actionIndex + 1}
                        {related.bindingIndex === undefined
                          ? ''
                          : ` / Mapping ${related.bindingIndex + 1}`}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div ref={bodyRef} className="im-editor__body">
        {payload.actions.length === 0 ? (
          <div className="im-editor__empty">No actions yet. Add an Action to start mapping keys.</div>
        ) : null}
        {payload.actions.length > 0 && visibleActionIndices.length === 0 ? (
          <div className="im-editor__empty">No actions match the current filters.</div>
        ) : null}

        <div
          className={virtualized ? 'im-editor__virtual' : 'im-editor__list'}
          style={virtualized ? { height: `${actionVirtualizer.getTotalSize()}px` } : undefined}
          data-testid={virtualized ? 'input-map-virtual-rows' : undefined}
        >
        {(virtualized ? actionVirtualizer.getVirtualItems() : visibleActionIndices).map((item) => {
          const virtualRow = typeof item === 'number' ? undefined : item;
          const actionIndex = typeof item === 'number'
            ? item
            : visibleActionIndices[item.index]!;
          const row = payload.actions[actionIndex]!;
          const collapsed = !forceExpanded && collapsedActions.has(actionIndex);
          const actionDiagnostics = diagnostics.filter(
            (diagnostic) => diagnostic.actionIndex === actionIndex,
          );
          const actionFieldDiagnostics = actionDiagnostics.filter(
            (diagnostic) => diagnostic.bindingIndex === undefined,
          );
          const actionSeverity = actionDiagnostics.some(
            (diagnostic) => diagnostic.severity === 'error',
          ) ? 'error' : actionDiagnostics.length > 0 ? 'warning' : undefined;
          const renderedAction = (
            <section
              key={`action-${actionIndex}`}
              className="im-action"
              data-testid={`input-map-action-${actionIndex}`}
              data-im-action={actionIndex}
              data-severity={actionSeverity}
              data-dragging={draggingAction === actionIndex ? '1' : '0'}
              data-drop-target={dropTargetAction === actionIndex ? '1' : '0'}
              onDragOver={(event) => {
                if (draggingAction === null || draggingAction === actionIndex) return;
                event.preventDefault();
                setDropTargetAction(actionIndex);
              }}
              onDragLeave={() => {
                if (dropTargetAction === actionIndex) setDropTargetAction(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingAction !== null) reorderAction(draggingAction, actionIndex);
                setDraggingAction(null);
                setDropTargetAction(null);
              }}
            >
              <div className="im-action__head">
                <button
                  type="button"
                  className="im-action__collapse"
                  aria-label={collapsed ? 'Expand action' : 'Collapse action'}
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsedActions((current) => {
                    const next = new Set(current);
                    if (next.has(actionIndex)) next.delete(actionIndex);
                    else next.add(actionIndex);
                    return next;
                  })}
                >
                  {collapsed ? '▸' : '▾'}
                </button>
                <button
                  type="button"
                  className="im-action__drag"
                  draggable
                  aria-label="Drag to reorder action"
                  title="Drag to reorder"
                  onDragStart={(event) => {
                    setDraggingAction(actionIndex);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', String(actionIndex));
                  }}
                  onDragEnd={() => {
                    setDraggingAction(null);
                    setDropTargetAction(null);
                  }}
                >
                  ⋮⋮
                </button>
                <span className="im-action__badge">Action</span>
                <input
                  className="im-action__name"
                  type="text"
                  value={row.action}
                  onChange={(e) => renameAction(actionIndex, e.target.value)}
                  aria-label="Action name"
                  spellCheck={false}
                />
                <label className="im-action__dz">
                  <span className="im-action__dz-label">DZ</span>
                  <input
                    className="im-action__dz-input"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    placeholder="—"
                    value={row.deadzone ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setDeadzone(actionIndex, raw === '' ? undefined : Number(raw));
                    }}
                    aria-label="Deadzone"
                  />
                </label>
                <div className="im-action__tools">
                  <button
                    type="button"
                    className="im-btn im-btn--ghost"
                    disabled={actionIndex === 0}
                    onClick={() => reorderAction(actionIndex, actionIndex - 1)}
                    aria-label="Move action up"
                    title="Move action up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="im-btn im-btn--ghost"
                    disabled={actionIndex === payload.actions.length - 1}
                    onClick={() => reorderAction(actionIndex, actionIndex + 1)}
                    aria-label="Move action down"
                    title="Move action down"
                  >
                    ↓
                  </button>
                </div>
                <button
                  type="button"
                  className="im-btn im-btn--ghost"
                  onClick={() => removeAction(actionIndex)}
                  aria-label="Remove action"
                  title="Remove action"
                >
                  ×
                </button>
              </div>

              {!collapsed && actionFieldDiagnostics.length > 0 ? (
                <div className="im-action__diagnostics">
                  {actionFieldDiagnostics.map((diagnostic) => (
                    <div
                      key={diagnostic.code}
                      className="im-inline-diagnostic"
                      data-severity={diagnostic.severity}
                    >
                      {diagnostic.message}
                    </div>
                  ))}
                </div>
              ) : null}

              {!collapsed ? <div className="im-action__mappings">
                <div className="im-action__mappings-label">
                  Mappings · {row.bindings.length}
                  <button
                    type="button"
                    className="im-btn"
                    onClick={() => { void pasteMappings(actionIndex); }}
                  >
                    Paste
                  </button>
                </div>

                {row.bindings.map((b, bindingIndex) => {
                  const bindingDiagnostics = actionDiagnostics.filter(
                    (diagnostic) => diagnostic.bindingIndex === bindingIndex,
                  );
                  const mappingMatchesQuery = normalizedQuery.length === 0
                    || row.action.toLowerCase().includes(normalizedQuery)
                    || bindingDisplay(b).toLowerCase().includes(normalizedQuery);
                  const mappingVisible = diagnosticFilter === 'all'
                    || (diagnosticFilter === 'errors' && bindingDiagnostics.some(
                      (diagnostic) => diagnostic.severity === 'error',
                    ))
                    || (diagnosticFilter === 'warnings' && bindingDiagnostics.some(
                      (diagnostic) => diagnostic.severity === 'warning',
                    ))
                    || (diagnosticFilter === 'shared' && bindingDiagnostics.some(
                      (diagnostic) => diagnostic.code === 'input-map-binding-shared',
                    ));
                  if (!mappingVisible || !mappingMatchesQuery) return null;
                  const bindingSeverity = bindingDiagnostics.some(
                    (diagnostic) => diagnostic.severity === 'error',
                  ) ? 'error' : bindingDiagnostics.length > 0 ? 'warning' : undefined;
                  return (
                    <div
                      key={`map-${actionIndex}-${bindingIndex}`}
                      className="im-map-wrap"
                      data-im-location={`${actionIndex}:${bindingIndex}`}
                    >
                      <div
                        className="im-map"
                        data-severity={bindingSeverity}
                        data-selected={selectedMappings.has(mappingKey(actionIndex, bindingIndex)) ? '1' : '0'}
                      >
                        <input
                          className="im-map__select"
                          type="checkbox"
                          checked={selectedMappings.has(mappingKey(actionIndex, bindingIndex))}
                          onChange={() => toggleMappingSelection(actionIndex, bindingIndex)}
                          aria-label={`Select mapping ${bindingIndex + 1}`}
                        />
                        <select
                          className="im-map__type"
                          value={b.type}
                          onChange={(e) => setBindingType(
                            actionIndex,
                            bindingIndex,
                            e.target.value as InputMapBinding['type'],
                          )}
                          aria-label="Binding type"
                        >
                          <option value="key">Keyboard</option>
                          <option value="mouseButton">Mouse</option>
                          <option value="gamepadButton">Gamepad Button</option>
                          <option value="gamepadAxis">Gamepad Axis</option>
                        </select>

                        <BindingValueSlot
                          binding={b}
                          listening={isListening(actionIndex, bindingIndex)}
                          onStartListen={() => setListening({
                            actionIndex,
                            bindingIndex,
                            kind: b.type,
                          })}
                          onCancelListen={() => setListening(null)}
                          onCommit={(next) => replaceBinding(actionIndex, bindingIndex, next)}
                        />

                        <button
                          type="button"
                          className="im-btn im-btn--ghost"
                          onClick={() => removeBinding(actionIndex, bindingIndex)}
                          aria-label="Remove mapping"
                          title="Remove mapping"
                        >
                          ×
                        </button>
                      </div>
                      {bindingDiagnostics.map((diagnostic) => (
                        <div
                          key={diagnostic.code}
                          className="im-inline-diagnostic im-inline-diagnostic--mapping"
                          data-severity={diagnostic.severity}
                        >
                          {diagnostic.message}
                        </div>
                      ))}
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="im-btn im-btn--add-map"
                  onClick={() => addBinding(actionIndex)}
                >
                  + Mapping
                </button>
              </div> : null}
            </section>
          );
          return virtualRow ? (
            <div
              key={`virtual-action-${actionIndex}`}
              ref={actionVirtualizer.measureElement}
              className="im-editor__virtual-row"
              data-index={virtualRow.index}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderedAction}
            </div>
          ) : renderedAction;
        })}
        </div>
      </div>
    </div>
  );
}

export default InputMapEditor;
