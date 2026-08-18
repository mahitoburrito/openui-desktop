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
const loadingLangs = new Map<string, Promise<void>>();
const loadingThemes = new Map<DiffTheme, Promise<void>>();

const languageAliases: Record<string, string> = {
  bash: "shell",
  shellscript: "shell",
  sh: "shell",
  zsh: "shell",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  html5: "html",
};

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

function normalizeLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase().replace(/^language-/, "");
  const resolved = languageAliases[normalized] ?? normalized;
  return langLoaders[resolved] ? resolved : null;
}

async function ensureTheme(hl: HighlighterCore, theme: DiffTheme): Promise<void> {
  if (loadedThemes.has(theme)) return;

  let pending = loadingThemes.get(theme);
  if (!pending) {
    pending = hl.loadTheme(themeLoaders[theme])
      .then(() => {
        loadedThemes.add(theme);
      })
      .finally(() => {
        loadingThemes.delete(theme);
      });
    loadingThemes.set(theme, pending);
  }
  await pending;
}

async function ensureLanguage(hl: HighlighterCore, language: string): Promise<void> {
  if (loadedLangs.has(language)) return;

  let pending = loadingLangs.get(language);
  if (!pending) {
    pending = hl.loadLanguage(langLoaders[language])
      .then(() => {
        loadedLangs.add(language);
      })
      .finally(() => {
        loadingLangs.delete(language);
      });
    loadingLangs.set(language, pending);
  }
  await pending;
}

export async function highlightCodeBlock(
  content: string,
  language: string,
  theme: DiffTheme
): Promise<string | null> {
  const resolvedLanguage = normalizeLanguage(language);
  if (!resolvedLanguage || !content.trim()) return null;

  try {
    const hl = await getHighlighter();
    await Promise.all([
      ensureTheme(hl, theme),
      ensureLanguage(hl, resolvedLanguage),
    ]);
    return hl.codeToHtml(content, { lang: resolvedLanguage, theme });
  } catch {
    return null;
  }
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
    ensureTheme(hl, theme)
      .then(() => setReadyTick((t) => t + 1))
      .catch(() => {});
  }, [hl, theme]);

  return (content: string, filePath: string): HighlightToken[] => {
    const plain = [{ text: content, color: "" }];
    if (!hl || content === "" || !loadedThemes.has(theme)) return plain;

    const lang = langForFile(filePath);
    const loader = langLoaders[lang];
    if (!loader) return plain; // unsupported language → plain text

    if (!loadedLangs.has(lang)) {
      ensureLanguage(hl, lang)
        .then(() => setReadyTick((t) => t + 1))
        .catch(() => {});
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
