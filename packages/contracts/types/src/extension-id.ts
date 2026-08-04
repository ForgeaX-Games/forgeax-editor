import { z } from 'zod';

/** Stable extension package identity shared by manifests and contribution ids. */
export const ExtensionIdSchema = z
  .string()
  .min(1)
  .regex(/^@[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9-_]*$/u, {
    message: 'extension id must be `@scope/name` (lowercase, kebab/snake; name may start with `_` for templates)',
  });

export const SemverLikeSchema = z.string().min(1);

export type ExtensionId = z.infer<typeof ExtensionIdSchema>;
