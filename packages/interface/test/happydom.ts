// bun test preload — register happy-dom so component/DOM-touching tests have a
// real document / Element / closest() etc. Pure-logic tests are unaffected.
//
// react resolves to the real runtime here (not @types/react/index.d.ts) because
// the `react` → *.d.ts path mappings live in tsconfig.lint.json, not the
// tsconfig.json bun reads — see that file's header for the full rationale.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
