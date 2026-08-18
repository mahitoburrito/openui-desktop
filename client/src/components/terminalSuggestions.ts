export type TerminalSuggestionKind =
  | "action"
  | "workflow"
  | "history"
  | "session"
  | "file"
  | "command"
  | "subcommand"
  | "option"
  | "argument"
  | "variable";

export interface TerminalSuggestion {
  id: string;
  kind: TerminalSuggestionKind;
  title: string;
  description: string;
  value: string;
  score: number;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export function applyTerminalSuggestion(query: string, suggestion: TerminalSuggestion): string {
  const start = suggestion.metadata?.replaceStart;
  const end = suggestion.metadata?.replaceEnd;
  if (typeof start === "number" && typeof end === "number" && start >= 0 && end >= start) {
    return `${query.slice(0, start)}${suggestion.value}${query.slice(end)}`;
  }
  return suggestion.value;
}

export const inlineSuggestionKinds = new Set<TerminalSuggestionKind>([
  "history",
  "file",
  "command",
  "subcommand",
  "option",
  "argument",
  "variable",
]);

export function completedTerminalCommand(query: string, suggestion: TerminalSuggestion): string {
  return applyTerminalSuggestion(query, suggestion);
}

export function terminalSuggestionSuffix(query: string, suggestion: TerminalSuggestion): string | null {
  const completed = completedTerminalCommand(query, suggestion);
  return completed.startsWith(query) && completed.length > query.length
    ? completed.slice(query.length)
    : null;
}

export function nextTerminalSuggestionComponent(suffix: string): string {
  const match = suffix.match(/^(?:\s+|[^\s/\\]+[/\\]?|[/\\]+)/);
  return match?.[0] || suffix;
}
