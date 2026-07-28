import { describe, expect, test } from 'bun:test';
import { shouldApplyHydratedWorkbenchLayout } from './workspace-hydration';

const started = { projectId: 'project-a', activeWorkbenchId: 'scene' };

describe('shouldApplyHydratedWorkbenchLayout', () => {
  test('accepts hydration only while its project and workbench still own the dock', () => {
    expect(shouldApplyHydratedWorkbenchLayout(started, started, 'scene')).toBe(true);
    expect(shouldApplyHydratedWorkbenchLayout(
      started,
      { projectId: 'project-a', activeWorkbenchId: 'ai' },
      'ai',
    )).toBe(false);
    expect(shouldApplyHydratedWorkbenchLayout(
      started,
      { projectId: 'project-b', activeWorkbenchId: 'scene' },
      'scene',
    )).toBe(false);
    expect(shouldApplyHydratedWorkbenchLayout(started, started, 'ai')).toBe(false);
  });
});
