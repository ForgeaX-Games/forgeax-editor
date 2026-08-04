/**
 * @forgeax/types — public surface.
 *
 * 每个 file 一个 concern。consumers 直接 `from '@forgeax/types/manifest'` 导入
 * 子模块，或 `from '@forgeax/types'` 拿 namespaces。
 */
export * from './i18n';
export * from './extension-id';
export * from './manifest';
export * from './page';
export * from './agent';
export * from './skill';
export * from './tool';
export * from './image-gen';
export * from './host-sdk';
export * from './persona-capability-surface';
export * from './observability';
export * from './memory-switch';
export * from './permission-rules';
export * from './shell-split';
export * from './visual-generation';
export * from './ledger-blob';
export * from './npc-protocol';
export * from './npc-tools';
export * from './capability';
