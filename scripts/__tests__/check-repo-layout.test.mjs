import { describe, expect, test } from 'bun:test';
import { findRootLayoutViolations } from '../check-repo-layout.mjs';

describe('editor repository layout contract', () => {
  test('accepts engine-style root ownership', () => {
    expect(findRootLayoutViolations([
      'AGENTS.md',
      'apps',
      'docs',
      'packages',
      'scripts',
      'tsconfig.json',
    ])).toEqual([]);
  });

  test('rejects source, test, types, and dependency configuration at root', () => {
    expect(findRootLayoutViolations([
      'src',
      'types',
      '__tests__',
      '.dependency-cruiser.cjs',
    ])).toEqual([
      'src: move repository-owned source, tests, types, or CI configuration under its owner',
      'types: move repository-owned source, tests, types, or CI configuration under its owner',
      '__tests__: move repository-owned source, tests, types, or CI configuration under its owner',
      '.dependency-cruiser.cjs: move repository-owned source, tests, types, or CI configuration under its owner',
    ]);
  });
});
