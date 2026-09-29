# Editor standalone application

Private application in the Editor repository. It composes the reusable Editor
implementation with the published Interface shell. It is not an npm product,
is not included in the `@forgeax/editor` tarball, and is never a dependency of
the root Editor package.

| Dependency | Ownership |
|:--|:--|
| `@forgeax/editor` (`file:../..`) | Public facade from this same checkout |
| Editor workspace packages | Editor implementation and UI |
| `@forgeax/interface` | Exact published application shell |

Install from the repository root after initializing its submodules: `bun install`.
The root Bun configuration uses hoisted linking so `file:../..` resolves to the
live root package, not a second copy of its source-export runtime. This is a
workspace application, not a separately cloned repository. No `bun link`
registration or standalone npm release is required.

| Command (from this directory) | Result |
|:--|:--|
| `bun run dev` | Start the existing standalone development stack |
| `bun run dev:host` | Start only the shell; expects the edit runtime to be running |
| `bun run build` | Build the shell into this app's ignored `dist/` directory |
| `bun test ./__tests__ --path-ignore-patterns=**/repro-console.test.mjs` | Run application unit and published dependency identity contracts |

Root commands `bun run dev:standalone`, `bun run dev`, and `bun fx start` remain
available. Shared Vite, development-stack, and Playwright configuration remain
repository-owned. Relative `FORGEAX_GAME_DIR` values resolve from the invoking
directory; use an absolute game path when switching between root and app commands.

`repro-console.test.mjs` is a separate live-server diagnostic, not a unit test:
run it only after starting the standalone stack. Browser E2E tests remain under
`e2e/__tests__/` and run through the root Playwright commands. Existing root
`bun run typecheck` and `bun fx ci` gates remain unchanged; a new whole-application
TypeScript gate is not introduced by this packaging change.
