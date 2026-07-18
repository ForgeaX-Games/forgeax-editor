// bun test preload — register happy-dom so component/DOM-touching tests have a
// real document / Element / focus event cascade. Pure-logic tests are unaffected.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

// Tell React 18+ this environment supports act() — without this flag React
// warns on every act() call and doesn't guarantee synchronous flush timing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
