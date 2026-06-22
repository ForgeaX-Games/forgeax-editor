// bun test preload — register happy-dom so component/DOM-touching tests have a
// real document / Element / closest() etc. Pure-logic tests are unaffected.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
