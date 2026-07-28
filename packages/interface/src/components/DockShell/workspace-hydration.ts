export interface WorkspaceHydrationContext {
  projectId: string;
  activeWorkbenchId: string;
}

/** An async layout fetch may only mutate the dock it was started for. */
export function shouldApplyHydratedWorkbenchLayout(
  started: WorkspaceHydrationContext,
  current: WorkspaceHydrationContext,
  renderedWorkbenchId: string,
): boolean {
  return started.projectId === current.projectId
    && started.activeWorkbenchId === current.activeWorkbenchId
    && started.activeWorkbenchId === renderedWorkbenchId;
}
