import type { ComponentType } from 'react';

/**
 * Coarse file family as classified by the host (Content Browser's
 * `fileFamilyOf`: code / config / doc / image / audio / font / model / ...).
 * Kept as a plain string so this package stays decoupled from the host's enum.
 */
export type FilePreviewFamily = string;

/**
 * Host-agnostic descriptor of the file to preview. Any surface (the Content
 * Browser detail panel today, the Files explorer tomorrow) builds this from its
 * own selection + a `/api/files` metadata read; renderers consume only this.
 */
export interface FilePreviewInput {
  /** On-disk path (host path convention). The preview's identity. */
  readonly path: string;
  readonly name: string;
  /** Host-provided coarse family. */
  readonly family: FilePreviewFamily;
  /** Lower-case extension without the leading dot (`''` when none). */
  readonly ext: string;
  readonly mime: string;
  readonly size: number;
  /** Decoded text content when the host already has it (text files only). */
  readonly content?: string;
  /** URL that streams the raw bytes — used by media/binary renderers. */
  readonly rawUrl: string;
}

/**
 * A registered way to preview a file. `match` decides whether this renderer
 * claims the file; `component` renders it. Higher `priority` wins; on a tie the
 * later registration wins, so a plugin registered after the builtins overrides
 * them for an overlapping match without needing to out-bid on priority.
 */
export interface FilePreviewRenderer {
  readonly id: string;
  /** Default `0`. Higher wins; ties resolve to the later registration. */
  readonly priority?: number;
  match(input: FilePreviewInput): boolean;
  readonly component: ComponentType<FilePreviewInput>;
}
