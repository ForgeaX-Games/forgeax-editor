// Gateway project-validation operation registration.
// The host supplies the provider; this applier never reads project files or
// duplicates scripts/game-validation.mjs rules.

import { sessionAppliers } from './appliers';
import {
  getProjectValidationProvider,
  normalizeProjectValidationResult,
  type ProjectValidationOptions,
} from './project-validation';

sessionAppliers.set('validateGameProject', (op) => {
  const provider = getProjectValidationProvider();
  if (provider === undefined) {
    return {
      ok: false,
      error: {
        code: 'project-validation-unavailable',
        hint: 'The active Editor host has not installed a project validation provider.',
        retryable: false,
        recoveryActions: ['editor.discover'],
      },
    };
  }
  const options = op as { readonly maxBytes?: unknown; readonly maxEntities?: unknown };
  const request: ProjectValidationOptions = {
    ...(typeof options.maxBytes === 'number' ? { maxBytes: options.maxBytes } : {}),
    ...(typeof options.maxEntities === 'number' ? { maxEntities: options.maxEntities } : {}),
  };
  return {
    ok: true,
    completion: provider.validate(request).then(normalizeProjectValidationResult),
  };
});
