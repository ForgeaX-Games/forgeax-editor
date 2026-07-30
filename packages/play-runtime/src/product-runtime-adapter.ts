import {
  allowedParentOrigins,
  onVagMessage,
  type VagReject,
} from '@forgeax/editor-core/protocol';

export interface PlayProductRuntimeControls {
  readonly pause: () => void | Promise<void>;
  readonly play: () => void | Promise<void>;
  readonly reload: () => void | Promise<void>;
}

export interface PlayProductRuntimeAdapterOptions {
  readonly target: Window;
  readonly controls: PlayProductRuntimeControls;
  readonly allowedOrigins?: readonly string[];
  readonly onReject?: (reject: VagReject) => void;
}

export interface PlayProductRuntimeAdapter {
  readonly dispose: () => void;
}

/**
 * Project product runtime controls onto the existing typed VAG boundary.
 * The play host owns the engine controls; this adapter owns no mutation path.
 */
export function createPlayProductRuntimeAdapter(options: PlayProductRuntimeAdapterOptions): PlayProductRuntimeAdapter {
  const dispose = onVagMessage(options.target, {
    allowedOrigins: options.allowedOrigins ?? allowedParentOrigins(),
    onReject: options.onReject,
    handlers: {
      VAG_PREVIEW_PAUSE: () => { void options.controls.pause(); },
      VAG_PREVIEW_PLAY: () => { void options.controls.play(); },
      VAG_PREVIEW_RELOAD: () => { void options.controls.reload(); },
    },
  });
  return { dispose };
}
