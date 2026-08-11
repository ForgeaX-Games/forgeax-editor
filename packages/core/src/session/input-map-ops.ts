// session/input-map-ops — Input Map document appliers (create / save).
//
// DOCUMENT-domain ops. Writes go through ctx.assetIO + authored-asset barrier.
// Anchors: charactercontrol-input-mapping-design P0 · MI ops pattern

import { broadcastAssetsChanged } from '../store/assets-changed';
import { broadcastAssetsError } from '../store/assets-error-bus';
import { scheduleAuthoredAssetWrite, trackPendingAssetWrite } from './authored-asset-write';
import { resolveGamePath } from '../util/path-resolver';
import {
  INPUT_MAP_KIND,
  createDefaultInputMapPayload,
  diagnoseInputMap,
  isGuid,
  isInputMapPayload,
  type InputMapAction,
  type InputMapPayload,
} from '../assets/input-map-schema';
import type { ApplyResult, EditorOp } from '../types';

interface InputMapApplierCtx {
  readonly assetIO: {
    createAssetInPack(args: {
      packPath: string;
      asset: {
        guid: string;
        kind: string;
        name: string;
        payload: unknown;
        refs?: string[];
      };
    }): Promise<{ ok: true } | { ok: false; reason: string; hint: string }>;
    writePackEntry(packPath: string, entry: unknown): Promise<boolean>;
  };
}

interface PackAssetEntry {
  guid: string;
  kind: string;
  name?: string;
  payload: Record<string, unknown>;
  refs: string[];
}

function ioFailHint(op: string, path: string, e: unknown): string {
  return `${op}("${path}") background IO failed: ${e instanceof Error ? e.message : String(e)}`;
}

function writeEntry(
  ctx: InputMapApplierCtx,
  packPath: string,
  entry: PackAssetEntry,
  opName: string,
): void {
  const completion = ctx.assetIO.writePackEntry(packPath, entry as never)
    .then((written) => {
      if (!written) {
        throw new Error('writePackEntry returned false');
      }
      broadcastAssetsChanged();
    });
  trackPendingAssetWrite(entry.guid, completion, (cause) => {
      const hint = ioFailHint(opName, packPath, cause);
      console.error(`[input-map] ${hint}`);
      broadcastAssetsError({ op: opName, path: packPath, hint });
  });
}

export function applyCreateInputMap(ctx: InputMapApplierCtx, cmd: EditorOp): ApplyResult {
  const {
    guid, name, actions, packPath,
  } = cmd as {
    guid: string;
    name: string;
    actions?: readonly InputMapAction[];
    packPath?: string;
  };

  if (!isGuid(guid)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createInputMap requires a non-empty RFC 4122 `guid`' } };
  }
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createInputMap requires a non-empty `name`' } };
  }

  const payload = createDefaultInputMapPayload(actions ?? []);
  if (!isInputMapPayload(payload)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createInputMap produced an invalid payload' } };
  }
  const createErrors = diagnoseInputMap(payload).filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (createErrors.length > 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: `createInputMap: ${createErrors.length} diagnostic error${createErrors.length === 1 ? '' : 's'}; ${createErrors[0]!.message}`,
      },
    };
  }

  let targetPack: string;
  if (typeof packPath === 'string' && packPath.length > 0) {
    targetPack = packPath;
  } else {
    // UE-style: one Input Map per pack file, named after the asset.
    targetPack = `assets/${name}.pack.json`;
  }
  // Keep GAME-RELATIVE — createAssetInPack resolves once. Pre-resolving here
  // double-nests the installed game root and Ctrl+S cannot find the relative pack.
  try {
    resolveGamePath(targetPack);
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: 'createInputMap requires an active game path resolver; select a game before authoring',
      },
    };
  }

  return scheduleAuthoredAssetWrite(ctx, targetPack, {
    guid,
    kind: INPUT_MAP_KIND,
    name,
    payload: payload as unknown as Record<string, unknown>,
    refs: [],
  });
}

export function applySaveInputMap(ctx: InputMapApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as {
    kind: 'saveInputMap';
    packPath: string;
    guid: string;
    payload: InputMapPayload;
    _oldEntry?: PackAssetEntry;
  };

  if (typeof cmd.packPath !== 'string' || cmd.packPath.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveInputMap: packPath required' } };
  }
  if (!isGuid(cmd.guid)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveInputMap: guid required' } };
  }
  if (!isInputMapPayload(cmd.payload)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveInputMap: payload must be an input-map' } };
  }
  const saveErrors = diagnoseInputMap(cmd.payload).filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (saveErrors.length > 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: `saveInputMap: ${saveErrors.length} diagnostic error${saveErrors.length === 1 ? '' : 's'}; ${saveErrors[0]!.message}`,
      },
    };
  }
  if (!cmd._oldEntry) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveInputMap: _oldEntry missing (gateway should fill)' } };
  }

  const nextEntry: PackAssetEntry = {
    ...cmd._oldEntry,
    kind: INPUT_MAP_KIND,
    payload: cmd.payload as unknown as Record<string, unknown>,
    refs: [],
  };
  writeEntry(ctx, cmd.packPath, nextEntry, 'saveInputMap');

  return {
    ok: true,
    inverse: {
      kind: 'saveInputMap',
      packPath: cmd.packPath,
      guid: cmd.guid,
      payload: cmd._oldEntry.payload,
      _oldEntry: nextEntry,
    } as unknown as EditorOp,
    created: [],
  };
}
