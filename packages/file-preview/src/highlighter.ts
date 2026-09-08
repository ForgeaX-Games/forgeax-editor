// shiki integration — a lazily-created singleton highlighter. Everything (the
// core, the regex engine, the theme, and each grammar) is loaded via dynamic
// import() so none of it lands in the host's initial bundle; a grammar is only
// fetched the first time a file of that language is previewed.
//
// The JavaScript regex engine is used deliberately: it needs no WASM, which
// keeps embedding trivial across the editor's web/desktop targets. `forgiving`
// downgrades the occasional grammar edge case to a no-op instead of throwing.

import type { HighlighterCore, LanguageInput, ThemeRegistrationRaw } from 'shiki/core';

export const HIGHLIGHT_THEME = 'github-dark-default';

type LangModule = { readonly default: LanguageInput };

/** Lazy grammar loaders keyed by shiki language id. Only ids referenced by
 *  ext-language.ts appear here; the specifiers stay static so bundlers can
 *  code-split each grammar into its own chunk. */
const LANG_LOADERS: Readonly<Record<string, () => Promise<LangModule>>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  wgsl: () => import('shiki/langs/wgsl.mjs'),
  glsl: () => import('shiki/langs/glsl.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
};

let corePromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const inFlightLangs = new Map<string, Promise<boolean>>();

async function getCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-dark-default.mjs'),
      ]);
      return createHighlighterCore({
        themes: [theme.default as ThemeRegistrationRaw],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return corePromise;
}

async function ensureLanguage(core: HighlighterCore, lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;
  const loader = LANG_LOADERS[lang];
  if (!loader) return false;
  let pending = inFlightLangs.get(lang);
  if (!pending) {
    pending = (async () => {
      const mod = await loader();
      await core.loadLanguage(mod.default);
      loadedLangs.add(lang);
      return true;
    })();
    inFlightLangs.set(lang, pending);
  }
  return pending;
}

/**
 * Highlight `code` as `lang`, returning shiki's `<pre class="shiki">…</pre>`
 * HTML, or `null` when the language is not available (caller renders plain text).
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  const core = await getCore();
  const ready = await ensureLanguage(core, lang);
  if (!ready) return null;
  return core.codeToHtml(code, { lang, theme: HIGHLIGHT_THEME });
}
