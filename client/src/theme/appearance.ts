export type WorkspaceBackgroundId = "graphite" | "moss" | "dusk" | "paper";
export type FocusBackdropId = "none" | "aurora" | "ember" | "abyss" | "meadow";
export type TerminalThemeId = "graphite" | "ember" | "paper" | "matrix";
export type TerminalFontFamilyId = "sf-mono" | "jetbrains" | "cascadia" | "berkeley";

export interface WorkspaceBackground {
  id: WorkspaceBackgroundId;
  name: string;
  description: string;
  canvas: string;
  canvasDark: string;
  dots: string;
  controls: string;
  border: string;
  preview: string[];
}

export interface TerminalTheme {
  id: TerminalThemeId;
  name: string;
  description: string;
  background: string;
  surface: string;
  border: string;
  foreground: string;
  muted: string;
  selection: string;
  cursorAccent: string;
  preview: string[];
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export interface TerminalFontFamily {
  id: TerminalFontFamilyId;
  name: string;
  stack: string;
}

export const WORKSPACE_BACKGROUNDS: WorkspaceBackground[] = [
  {
    id: "graphite",
    name: "Graphite",
    description: "Cool graphite workspace",
    canvas: "oklch(14.5% 0.006 255)",
    canvasDark: "oklch(12% 0.006 255)",
    dots: "oklch(28% 0.008 255)",
    controls: "oklch(17% 0.007 255)",
    border: "oklch(29% 0.009 255)",
    preview: ["oklch(14.5% 0.006 255)", "oklch(20% 0.008 255)", "oklch(67% 0.13 250)"],
  },
  {
    id: "moss",
    name: "Moss",
    description: "Dark olive for long sessions",
    canvas: "oklch(15% 0.018 145)",
    canvasDark: "oklch(12% 0.015 145)",
    dots: "oklch(32% 0.026 145)",
    controls: "oklch(21% 0.02 145)",
    border: "oklch(34% 0.024 145)",
    preview: ["oklch(15% 0.018 145)", "oklch(24% 0.026 145)", "oklch(72% 0.13 140)"],
  },
  {
    id: "dusk",
    name: "Sienna",
    description: "Warm graphite with restrained orange",
    canvas: "oklch(14% 0.011 42)",
    canvasDark: "oklch(10.5% 0.01 42)",
    dots: "oklch(30% 0.016 42)",
    controls: "oklch(19% 0.013 42)",
    border: "oklch(31% 0.016 42)",
    preview: ["oklch(14% 0.011 42)", "oklch(23% 0.015 42)", "oklch(68% 0.15 48)"],
  },
  {
    id: "paper",
    name: "Paper",
    description: "Light canvas with dark panes",
    canvas: "oklch(91% 0.014 82)",
    canvasDark: "oklch(84% 0.015 82)",
    dots: "oklch(70% 0.02 82)",
    controls: "oklch(96% 0.01 82)",
    border: "oklch(77% 0.018 82)",
    preview: ["oklch(91% 0.014 82)", "oklch(80% 0.018 82)", "oklch(36% 0.038 120)"],
  },
];

export interface FocusBackdrop {
  id: FocusBackdropId;
  name: string;
  description: string;
  /** Layered CSS background painted behind the focus-mode panes. */
  background: string;
  preview: string[];
}

// iMessage-style wallpapers for focus mode: quiet washes over the graphite
// base so terminals stay legible while the workspace picks up a mood.
export const FOCUS_BACKDROPS: FocusBackdrop[] = [
  {
    id: "none",
    name: "Graphite",
    description: "Plain workspace",
    background: "oklch(8.5% 0.004 260 / 0.34)",
    preview: ["oklch(8.5% 0.004 260)"],
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Violet and blue wash",
    background:
      "radial-gradient(120% 90% at 12% -10%, oklch(36% 0.1 295 / 0.18), transparent 55%), radial-gradient(110% 85% at 95% 110%, oklch(38% 0.09 230 / 0.15), transparent 60%), oklch(8.5% 0.004 260 / 0.36)",
    preview: ["oklch(24% 0.07 295)", "oklch(22% 0.06 230)"],
  },
  {
    id: "ember",
    name: "Ember",
    description: "Low warm glow",
    background:
      "radial-gradient(120% 95% at 85% -10%, oklch(38% 0.07 45 / 0.16), transparent 55%), radial-gradient(100% 80% at 5% 110%, oklch(32% 0.06 25 / 0.13), transparent 60%), oklch(8.5% 0.004 260 / 0.36)",
    preview: ["oklch(24% 0.05 45)", "oklch(18% 0.04 25)"],
  },
  {
    id: "abyss",
    name: "Abyss",
    description: "Deep ocean blue",
    background:
      "radial-gradient(130% 100% at 50% -15%, oklch(30% 0.08 250 / 0.2), transparent 60%), linear-gradient(180deg, oklch(10% 0.02 250 / 0.4), oklch(8% 0.015 260 / 0.32))",
    preview: ["oklch(22% 0.06 250)", "oklch(12% 0.02 255)"],
  },
  {
    id: "meadow",
    name: "Meadow",
    description: "Soft green field",
    background:
      "radial-gradient(120% 90% at 20% -10%, oklch(34% 0.07 150 / 0.16), transparent 55%), radial-gradient(100% 80% at 90% 110%, oklch(30% 0.06 175 / 0.13), transparent 60%), oklch(8.5% 0.004 260 / 0.36)",
    preview: ["oklch(22% 0.05 150)", "oklch(16% 0.04 175)"],
  },
];

export const TERMINAL_THEMES: TerminalTheme[] = [
  {
    id: "graphite",
    name: "Default",
    description: "Out-of-the-box Claude Code and Codex CLI look",
    background: "#0d0f0f",
    surface: "#111414",
    border: "#252a28",
    foreground: "#e5e7e5",
    muted: "#8f9892",
    selection: "#303733",
    cursorAccent: "#0d0f0f",
    preview: ["#0d0f0f", "#232927", "#d8ded8", "#8ec07c"],
    ansi: {
      black: "#171b1a",
      red: "#ee6f6f",
      green: "#8ec07c",
      yellow: "#d8a657",
      blue: "#7daea3",
      magenta: "#d3869b",
      cyan: "#89b482",
      white: "#e5e7e5",
      brightBlack: "#59615c",
      brightRed: "#f09393",
      brightGreen: "#a9d59b",
      brightYellow: "#e7bf78",
      brightBlue: "#9ac6bd",
      brightMagenta: "#e2a8b7",
      brightCyan: "#a5d5a0",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "ember",
    name: "Ember",
    description: "Warm console glow",
    background: "#15100d",
    surface: "#1a1410",
    border: "#342822",
    foreground: "#eaded0",
    muted: "#9a897b",
    selection: "#403029",
    cursorAccent: "#15100d",
    preview: ["#15100d", "#33231b", "#eaded0", "#f0a45d"],
    ansi: {
      black: "#211814",
      red: "#f16b64",
      green: "#8fcf8f",
      yellow: "#e4b66b",
      blue: "#88b8d8",
      magenta: "#d99ad6",
      cyan: "#83cfc4",
      white: "#eaded0",
      brightBlack: "#6f5f52",
      brightRed: "#ff938b",
      brightGreen: "#aae0a7",
      brightYellow: "#f0c986",
      brightBlue: "#a6cce4",
      brightMagenta: "#e9b2e6",
      brightCyan: "#9ce0d7",
      brightWhite: "#f7f1e9",
    },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Bright review mode",
    background: "#efeee8",
    surface: "#e4e1d8",
    border: "#c8c1b3",
    foreground: "#252a28",
    muted: "#6e716b",
    selection: "#d7cfbf",
    cursorAccent: "#efeee8",
    preview: ["#efeee8", "#d7cfbf", "#252a28", "#466d53"],
    ansi: {
      black: "#343a38",
      red: "#b54842",
      green: "#466d53",
      yellow: "#8d692e",
      blue: "#365f78",
      magenta: "#7a4e75",
      cyan: "#306d68",
      white: "#e5e1d8",
      brightBlack: "#747870",
      brightRed: "#c85d56",
      brightGreen: "#5a815f",
      brightYellow: "#9d7a3b",
      brightBlue: "#4c7691",
      brightMagenta: "#8c6387",
      brightCyan: "#477f7a",
      brightWhite: "#f7f5ef",
    },
  },
  {
    id: "matrix",
    name: "Matrix",
    description: "Green high-contrast shell",
    background: "#07110c",
    surface: "#0b1810",
    border: "#183522",
    foreground: "#d6f5dc",
    muted: "#6e8c75",
    selection: "#183522",
    cursorAccent: "#07110c",
    preview: ["#07110c", "#183522", "#d6f5dc", "#54d86a"],
    ansi: {
      black: "#0d1710",
      red: "#f06a6f",
      green: "#54d86a",
      yellow: "#ccd66a",
      blue: "#73b8d8",
      magenta: "#c98de4",
      cyan: "#72d8bf",
      white: "#d6f5dc",
      brightBlack: "#507158",
      brightRed: "#fa8e93",
      brightGreen: "#87ea94",
      brightYellow: "#dee884",
      brightBlue: "#9bcde6",
      brightMagenta: "#dcb0ef",
      brightCyan: "#96e8d5",
      brightWhite: "#f0f8ef",
    },
  },
];

export const TERMINAL_FONT_FAMILIES: TerminalFontFamily[] = [
  {
    id: "sf-mono",
    name: "SF Mono",
    stack: '"SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Code", monospace',
  },
  {
    id: "jetbrains",
    name: "SF Compact",
    stack: '"SF Mono", "SF Pro Text", ui-monospace, "JetBrains Mono", Menlo, Monaco, monospace',
  },
  {
    id: "cascadia",
    name: "SF Rounded",
    stack: '"SF Mono", "SF Pro Rounded", ui-monospace, "Cascadia Code", Menlo, Monaco, monospace',
  },
  {
    id: "berkeley",
    name: "SF Classic",
    stack: '"SF Mono", "SF Pro Text", ui-monospace, "Berkeley Mono", Menlo, Monaco, monospace',
  },
];

export const DEFAULT_APPEARANCE = {
  workspaceBackground: "graphite" as WorkspaceBackgroundId,
  focusBackdrop: "none" as FocusBackdropId,
  terminalTheme: "graphite" as TerminalThemeId,
  terminalFontFamily: "sf-mono" as TerminalFontFamilyId,
  terminalFontSize: 13,
};

export function getFocusBackdrop(id: FocusBackdropId): FocusBackdrop {
  return FOCUS_BACKDROPS.find((backdrop) => backdrop.id === id) ?? FOCUS_BACKDROPS[0];
}

export function isFocusBackdropId(value: unknown): value is FocusBackdropId {
  return typeof value === "string" && FOCUS_BACKDROPS.some((backdrop) => backdrop.id === value);
}

export function getWorkspaceBackground(id: WorkspaceBackgroundId): WorkspaceBackground {
  return WORKSPACE_BACKGROUNDS.find((theme) => theme.id === id) ?? WORKSPACE_BACKGROUNDS[0];
}

export function getTerminalTheme(id: TerminalThemeId): TerminalTheme {
  return TERMINAL_THEMES.find((theme) => theme.id === id) ?? TERMINAL_THEMES[0];
}

export function getTerminalFontFamily(id: TerminalFontFamilyId): TerminalFontFamily {
  return TERMINAL_FONT_FAMILIES.find((font) => font.id === id) ?? TERMINAL_FONT_FAMILIES[0];
}

export function isWorkspaceBackgroundId(value: unknown): value is WorkspaceBackgroundId {
  return typeof value === "string" && WORKSPACE_BACKGROUNDS.some((theme) => theme.id === value);
}

export function isTerminalThemeId(value: unknown): value is TerminalThemeId {
  return typeof value === "string" && TERMINAL_THEMES.some((theme) => theme.id === value);
}

export function isTerminalFontFamilyId(value: unknown): value is TerminalFontFamilyId {
  return typeof value === "string" && TERMINAL_FONT_FAMILIES.some((font) => font.id === value);
}

export function clampTerminalFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPEARANCE.terminalFontSize;
  }
  return Math.min(18, Math.max(11, Math.round(value)));
}
