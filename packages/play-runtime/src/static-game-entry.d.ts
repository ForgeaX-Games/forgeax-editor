declare module 'virtual:forgeax-static-game-entry' {
  const bootstrap: import('@forgeax/engine-app').BootstrapEntry | null;
  export { bootstrap };
}

declare module 'virtual:forgeax-static-game-plugins' {
  const modules: ReadonlyArray<{ clientPath: string; url: string }>;
  const importModule: (url: string) => Promise<unknown>;
  export { modules, importModule };
}
