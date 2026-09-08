/** Host-facing editor menu contribution. Interface already owns builtin menus;
 *  this extension is the editor pin's public assembly hook for Studio IDE. */
export function createEditorMenuExtension(): {
  readonly id: string;
  readonly version: string;
  setup(): () => void;
} {
  return {
    id: 'editor.menu-contributions',
    version: '1.0.0',
    setup() {
      return () => {};
    },
  };
}
