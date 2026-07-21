import type { ContextKeysApi } from '../extension-foundation/context-keys';
import { evaluateContextExpression } from './context-expression';
import type { ResolvedPanelActionState } from './types';

interface ActionStateSource {
  readonly when?: string;
  readonly enablement?: string;
  readonly activeWhen?: string;
  readonly highlightWhen?: string;
}

export function resolvePanelActionState(
  action: ActionStateSource,
  contextKeys: ContextKeysApi,
): ResolvedPanelActionState {
  return {
    visible: evaluateContextExpression(action.when, contextKeys, true),
    enabled: evaluateContextExpression(action.enablement, contextKeys, true),
    active: evaluateContextExpression(action.activeWhen, contextKeys, false),
    highlighted: evaluateContextExpression(action.highlightWhen, contextKeys, false),
  };
}
