import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createDefaultInputMapPayload,
  deleteInputMapMappings,
  diagnoseInputMap,
  filterInputMapActions,
  isInputMapPayload,
  pasteInputMapMappings,
  repairInputMapErrors,
  reorderInputMapActions,
  type InputMapAction,
  type InputMapPayload,
} from '../../../../core/src/assets/input-map-schema';

const GUID = '22222222-2222-4222-8222-222222222222';
let payload: InputMapPayload = createDefaultInputMapPayload();

mock.module('@forgeax/editor-core', () => ({
  createDefaultInputMapPayload,
  deleteInputMapMappings,
  diagnoseInputMap,
  filterInputMapActions,
  isInputMapPayload,
  pasteInputMapMappings,
  repairInputMapErrors,
  reorderInputMapActions,
  getInputMapStaging: () => ({
    guid: GUID,
    packPath: 'assets/IM_Test.pack.json',
    name: 'IM_Test',
    saveStatus: 'idle',
    saved: payload,
    staging: payload,
  }),
  isInputMapStagingDirty: () => false,
  keepInputMapStaging: () => {},
  openInputMapStaging: () => {},
  reloadInputMapStaging: () => {},
  subscribeInputMapStaging: () => () => {},
  trySaveActivePage: () => true,
  updateInputMapStaging: (_guid: string, update: (current: InputMapPayload) => InputMapPayload) => {
    payload = update(payload);
    return payload;
  },
  useActiveEditorAsset: () => ({
    guid: GUID,
    kind: 'input-map',
    name: 'IM_Test',
    packPath: 'assets/IM_Test.pack.json',
    payload,
  }),
}));

mock.module('@forgeax/editor-ui', () => ({
  confirm: async () => true,
  toast: {
    error: () => {},
    info: () => {},
    success: () => {},
  },
}));

async function renderEditor(actions: readonly InputMapAction[]): Promise<string> {
  payload = createDefaultInputMapPayload(actions);
  const { InputMapEditor } = await import('../InputMapEditor');
  return renderToStaticMarkup(<InputMapEditor />);
}

describe('InputMapEditor controls', () => {
  it('renders unified search, filters, transfer, save, and mapping controls', async () => {
    const html = await renderEditor([{
      action: 'jump',
      bindings: [{ type: 'key', key: ' ' }],
    }]);

    expect(html).toContain('data-testid="input-map-search"');
    expect(html).toContain('data-testid="input-map-filter-errors"');
    expect(html).toContain('data-testid="input-map-save"');
    expect(html).toContain('Import JSON');
    expect(html).toContain('Export JSON');
    expect(html).toContain('Select mapping 1');
    expect(html).toContain('Drag to reorder action');
    expect(html).toContain('Paste');
  });

  it('switches large action collections to the virtualized list owner', async () => {
    const actions = Array.from({ length: 50 }, (_, index): InputMapAction => ({
      action: `action-${index}`,
      bindings: [{ type: 'key', key: String(index) }],
    }));
    const html = await renderEditor(actions);

    expect(html).toContain('data-testid="input-map-virtual-rows"');
  });

  it('accepts only complete Input Map payload JSON and exports the current payload', async () => {
    const { parseInputMapJson, serializeInputMapJson } = await import('../InputMapEditor');
    const source = createDefaultInputMapPayload([{
      action: 'fire',
      bindings: [{ type: 'mouseButton', button: 0 }],
    }]);

    expect(parseInputMapJson('{"actions":[]}')).toBeNull();
    expect(parseInputMapJson('not json')).toBeNull();
    expect(parseInputMapJson(serializeInputMapJson(source))).toEqual(source);
  });
});
