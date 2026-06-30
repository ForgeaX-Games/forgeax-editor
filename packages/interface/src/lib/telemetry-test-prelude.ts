/**
 * 单测前置(仅测试用,无生产引用):阻止 store.ts 模块加载时的 daemon-WS 自动连接。
 *
 * store.ts 在 `typeof window !== 'undefined'` 下会在模块求值时 `connectDaemonWs(...)`,
 * happy-dom 里这会留下一个悬挂的重连 setTimeout → 测试帧 teardown 时报
 * 「AsyncTaskManager has been destroyed」。store 用一个全局 string 旗标
 * `__FORGEAX_DAEMON_WS_BOUND__` 作「已绑定」判据;在 import store **之前**把它置上,
 * store 就走「只更新 handler、不再 connect」分支(store.ts:1538-1546)。
 *
 * 用法:在任何会(直接或经组件)import 大 store 的测试文件里,把本模块作为**第一个**
 * side-effect import 放最上面(ESM 按出现顺序求值,确保先于 store)。
 */
(globalThis as Record<string, unknown>).__FORGEAX_DAEMON_WS_BOUND__ ??= { handler: () => {} };
