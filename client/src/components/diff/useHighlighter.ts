import { useEffect, useState } from "react";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeInput,
  type ThemedToken,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { type DiffTheme } from "../../stores/useStore";
import { langForFile } from "./diffModel";

// Languages we eagerly bundle. Anything else falls back to plain text — keeps
// the build graph small instead of pulling in all ~200 Shiki grammars.
const langLoaders: Record<string, LanguageInput> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  shell: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
};

const themeLoaders: Record<DiffTheme, ThemeInput> = {
  "github-dark": () => import("shiki/themes/github-dark.mjs"),
  "github-light": () => import("shiki/themes/github-light.mjs"),
  "one-dark-pro": () => import("shiki/themes/one-dark-pro.mjs"),
  dracula: () => import("shiki/themes/dracula.mjs"),
  nord: () => import("shiki/themes/nord.mjs"),
  "vitesse-dark": () => import("shiki/themes/vitesse-dark.mjs"),
};

// One shared Shiki core instance for the whole app, with themes/languages
// loaded lazily on demand.
let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const loadedThemes = new Set<DiffTheme>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [themeLoaders["github-dark"]],
      langs: [langLoaders.typescript, langLoaders.tsx],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).then((hl) => {
      loadedThemes.add("github-dark");
      loadedLangs.add("typescript");
      loadedLangs.add("tsx");
      return hl;
    });
  }
  return highlighterPromise;
}

export interface HighlightToken {
  text: string;
  color: string;
}

// Returned by the hook: synchronously turn a line of code into colored tokens.
// Before Shiki/the language is ready it returns a single uncolored token, so
// the diff still renders immediately and gains color on the next paint.
export type Highlight = (content: string, filePath: string) => HighlightToken[];

export function useHighlighter(theme: DiffTheme): Highlight {
  const [hl, setHl] = useState<HighlighterCore | null>(null);
  // Bump to force re-render when a new language/theme finishes loading.
  const [, setReadyTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((h) => {
      if (!cancelled) setHl(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Ensure the active theme is loaded.
  useEffect(() => {
    if (!hl || loadedThemes.has(theme)) return;
    loadedThemes.add(theme);
    hl.loadTheme(themeLoaders[theme])
      .then(() => setReadyTick((t) => t + 1))
      .catch(() => {
        loadedThemes.delete(theme);
      });
  }, [hl, theme]);

  return (content: string, filePath: string): HighlightToken[] => {
    const plain = [{ text: content, color: "" }];
    if (!hl || content === "" || !loadedThemes.has(theme)) return plain;

    const lang = langForFile(filePath);
    const loader = langLoaders[lang];
    if (!loader) return plain; // unsupported language → plain text

    if (!loadedLangs.has(lang)) {
      loadedLangs.add(lang);
      hl.loadLanguage(loader)
        .then(() => setReadyTick((t) => t + 1))
        .catch(() => {
          loadedLangs.delete(lang);
        });
      return plain;
    }

    try {
      if (!hl.getLoadedLanguages().includes(lang)) return plain;
      const result = hl.codeToTokens(content, { lang, theme });
      const line = result.tokens[0] ?? [];
      return line.map((t: ThemedToken) => ({
        text: t.content,
        color: t.color ?? "",
      }));
    } catch {
      return plain;
    }
  };
}
