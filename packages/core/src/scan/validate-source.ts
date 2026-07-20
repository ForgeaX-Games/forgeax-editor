// scan/validate-source.ts — source file validation before import (G5).
//
// Validates files against magic bytes, size constraints, and naming conventions.
// Accumulates ScanDiagnostic entries; never throws or blocks the pipeline.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G5

import type { ScanDiagnostic } from './scan-diagnostic';
import { isImportable, getImportFormat } from './ext-importer-map';

/** Known file format magic bytes for validation. */
const MAGIC_BYTES: Record<string, { bytes: number[]; label: string }> = {
  '.glb': { bytes: [0x67, 0x6C, 0x54, 0x46], label: 'glTF' },   // "glTF"
  '.fbx': { bytes: [0x4B, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6E, 0x61, 0x72, 0x79, 0x20, 0x20], label: 'Kaydara FBX Binary' },
  '.png': { bytes: [0x89, 0x50, 0x4E, 0x47], label: 'PNG' },     // \x89PNG
  '.jpg': { bytes: [0xFF, 0xD8, 0xFF], label: 'JPEG' },
  '.jpeg': { bytes: [0xFF, 0xD8, 0xFF], label: 'JPEG' },
  '.hdr': { bytes: [0x23, 0x3F, 0x52, 0x41], label: 'Radiance HDR' }, // "#?RA"
};

/** Maximum file size before warning (500MB). */
const MAX_SIZE_WARN = 500 * 1024 * 1024;

/**
 * Validate a source file's magic bytes against its extension.
 *
 * @param filePath - relative path within assets/
 * @param bytes - first 64 bytes of the file (enough for all magic byte checks)
 * @param fileSize - total file size in bytes
 * @returns array of diagnostics (empty = valid)
 */
export function validateSource(
  filePath: string,
  bytes: Uint8Array,
  fileSize: number,
): ScanDiagnostic[] {
  const diagnostics: ScanDiagnostic[] = [];
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

  // Check: file is empty
  if (fileSize === 0) {
    diagnostics.push({
      file: filePath,
      severity: 'error',
      code: 'empty-file',
      message: `File is empty (0 bytes)`,
      suggestion: 'Replace with valid file or delete.',
    });
    return diagnostics;
  }

  // Check: file too large
  if (fileSize > MAX_SIZE_WARN) {
    diagnostics.push({
      file: filePath,
      severity: 'warn',
      code: 'oversized-file',
      message: `File is very large (${(fileSize / 1024 / 1024).toFixed(1)} MB). Import may be slow.`,
      suggestion: 'Consider optimizing or using a smaller file.',
    });
  }

  // Check: extension supported
  const format = getImportFormat(ext);
  if (!format) {
    diagnostics.push({
      file: filePath,
      severity: 'warn',
      code: 'unsupported-format',
      message: `Unsupported file extension "${ext}". File will be skipped.`,
      suggestion: 'Use a supported format or register a new importer.',
    });
    return diagnostics;
  }

  // Check: magic bytes for known formats
  const magic = MAGIC_BYTES[ext];
  if (magic && bytes.length >= magic.bytes.length) {
    let match = true;
    for (let i = 0; i < magic.bytes.length; i++) {
      if (bytes[i] !== magic.bytes[i]) {
        match = false;
        break;
      }
    }
    if (!match) {
      diagnostics.push({
        file: filePath,
        severity: 'error',
        code: `invalid-${ext.slice(1)}-header`,
        message: `File does not have valid ${magic.label} magic bytes`,
        suggestion: 'File may be corrupted or incorrectly renamed.',
      });
    }
  }

  // Check: non-ASCII filename
  if (/[^\x00-\x7F]/.test(filePath)) {
    diagnostics.push({
      file: filePath,
      severity: 'warn',
      code: 'non-ascii-filename',
      message: `Filename contains non-ASCII characters`,
      suggestion: 'Use ASCII-only filenames for cross-platform compatibility.',
    });
  }

  return diagnostics;
}

/** Validate a source file using only path and size (no content bytes). */
export function validateSourceQuick(filePath: string, fileSize: number): ScanDiagnostic[] {
  return validateSource(filePath, new Uint8Array(), fileSize);
}
