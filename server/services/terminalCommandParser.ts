export type TerminalQuoteStyle = "single" | "double";

export interface TerminalParsedToken {
  value: string;
  raw: string;
  start: number;
  end: number;
  quoteStyle?: TerminalQuoteStyle;
  quoteStyleHint?: TerminalQuoteStyle;
  quoteOpen?: boolean;
  hadEscape: boolean;
}

export interface TerminalParsedCommand {
  tokens: TerminalParsedToken[];
  start: number;
  end: number;
  trailingWhitespace: boolean;
  escapeCharacter: "\\" | "`";
  powershell: boolean;
}

const MAX_TERMINAL_PARSE_CHARS = 64_000;

function shellName(shell: string | undefined): string {
  return (shell || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "") || "";
}

function isPowerShell(shell: string | undefined): boolean {
  const name = shellName(shell);
  return name === "pwsh" || name === "powershell";
}

interface CommandFrame {
  commandStart: number;
  hasCommandContent: boolean;
  close?: ")" | "}" | "`";
  restoreQuote?: TerminalQuoteStyle;
}

function separatorLength(source: string, index: number, end: number): number {
  const value = source[index];
  if (value === "\n" || value === ";") return 1;
  if (value !== "|" && value !== "&") return 0;
  // `2>&1` is a redirection, not a background-command separator.
  if (value === "&" && index > 0 && (source[index - 1] === ">" || source[index - 1] === "<")) {
    return 0;
  }
  return index + 1 < end && source[index + 1] === value ? 2 : 1;
}

function activeCommandStart(
  source: string,
  end: number,
  powershell: boolean,
  escapeCharacter: "\\" | "`",
): number {
  const frames: CommandFrame[] = [{ commandStart: 0, hasCommandContent: false }];
  let quote: TerminalQuoteStyle | undefined;

  for (let index = 0; index < end;) {
    const value = source[index];
    const frame = frames[frames.length - 1];

    if (quote === "single") {
      if (value === "'" && powershell && index + 1 < end && source[index + 1] === "'") {
        index += 2;
        continue;
      }
      if (value === "'") quote = undefined;
      index += 1;
      continue;
    }

    if (value === escapeCharacter) {
      frame.hasCommandContent = true;
      index += Math.min(2, end - index);
      continue;
    }

    if (quote === "double") {
      if (value === '"') {
        quote = undefined;
        index += 1;
        continue;
      }
      if (value === "$" && index + 1 < end && source[index + 1] === "(") {
        frame.hasCommandContent = true;
        frames.push({ commandStart: index + 2, hasCommandContent: false, close: ")", restoreQuote: quote });
        quote = undefined;
        index += 2;
        continue;
      }
      if (!powershell && value === "`") {
        frame.hasCommandContent = true;
        frames.push({ commandStart: index + 1, hasCommandContent: false, close: "`", restoreQuote: quote });
        quote = undefined;
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }

    if (frame.close === value) {
      const completed = frames.pop();
      quote = completed?.restoreQuote;
      index += 1;
      continue;
    }

    if (value === "'" || value === '"') {
      frame.hasCommandContent = true;
      quote = value === "'" ? "single" : "double";
      index += 1;
      continue;
    }
    if (value === "$" && index + 1 < end && source[index + 1] === "(") {
      frame.hasCommandContent = true;
      frames.push({ commandStart: index + 2, hasCommandContent: false, close: ")" });
      index += 2;
      continue;
    }
    if (!powershell && value === "`") {
      frame.hasCommandContent = true;
      frames.push({ commandStart: index + 1, hasCommandContent: false, close: "`" });
      index += 1;
      continue;
    }

    if ((value === "(" || value === "{") && !frame.hasCommandContent) {
      frames.push({
        commandStart: index + 1,
        hasCommandContent: false,
        close: value === "(" ? ")" : "}",
      });
      index += 1;
      continue;
    }

    const separator = separatorLength(source, index, end);
    if (separator) {
      frame.commandStart = index + separator;
      frame.hasCommandContent = false;
      index += separator;
      continue;
    }
    if (!/\s/.test(value)) frame.hasCommandContent = true;
    index += 1;
  }

  return frames[frames.length - 1].commandStart;
}

function findDollarSubshellEnd(
  source: string,
  start: number,
  end: number,
  powershell: boolean,
  escapeCharacter: "\\" | "`",
): number {
  let depth = 1;
  let quote: TerminalQuoteStyle | undefined;
  for (let index = start; index < end;) {
    const value = source[index];
    if (quote === "single") {
      if (value === "'" && powershell && index + 1 < end && source[index + 1] === "'") {
        index += 2;
        continue;
      }
      if (value === "'") quote = undefined;
      index += 1;
      continue;
    }
    if (value === escapeCharacter) {
      index += Math.min(2, end - index);
      continue;
    }
    if (quote === "double") {
      if (value === '"') quote = undefined;
      index += 1;
      continue;
    }
    if (value === "'" || value === '"') {
      quote = value === "'" ? "single" : "double";
      index += 1;
      continue;
    }
    if (value === "(") depth += 1;
    else if (value === ")" && --depth === 0) return index + 1;
    index += 1;
  }
  return end;
}

function findBacktickEnd(source: string, start: number, end: number): number {
  for (let index = start; index < end; index++) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "`") return index + 1;
  }
  return end;
}

interface TokenBuilder {
  value: string;
  start: number;
  end: number;
  quoteStyles: Set<TerminalQuoteStyle>;
  unquotedContent: boolean;
  hadEscape: boolean;
}

function tokenizeCommand(
  source: string,
  start: number,
  end: number,
  powershell: boolean,
  escapeCharacter: "\\" | "`",
): Pick<TerminalParsedCommand, "tokens" | "trailingWhitespace"> {
  const tokens: TerminalParsedToken[] = [];
  let current: TokenBuilder | undefined;
  let quote: TerminalQuoteStyle | undefined;
  let atBoundary = true;

  const ensureCurrent = (position: number): TokenBuilder => {
    current ||= {
      value: "",
      start: position,
      end: position,
      quoteStyles: new Set<TerminalQuoteStyle>(),
      unquotedContent: false,
      hadEscape: false,
    };
    return current;
  };
  const finishCurrent = () => {
    if (!current) return;
    const quoteStyle = !current.unquotedContent && current.quoteStyles.size === 1
      ? [...current.quoteStyles][0]
      : undefined;
    tokens.push({
      value: current.value,
      raw: source.slice(current.start, current.end),
      start: current.start,
      end: current.end,
      quoteStyle,
      quoteStyleHint: current.quoteStyles.values().next().value,
      quoteOpen: quote !== undefined || undefined,
      hadEscape: current.hadEscape,
    });
    current = undefined;
  };

  for (let index = start; index < end;) {
    const value = source[index];

    if (quote === "single") {
      const token = ensureCurrent(index);
      if (value === "'" && powershell && index + 1 < end && source[index + 1] === "'") {
        token.value += "'";
        token.end = index + 2;
        index += 2;
        atBoundary = false;
        continue;
      }
      if (value === "'") {
        quote = undefined;
        token.end = index + 1;
        index += 1;
        atBoundary = false;
        continue;
      }
      token.value += value;
      token.end = index + 1;
      index += 1;
      atBoundary = false;
      continue;
    }

    if (quote === "double") {
      const token = ensureCurrent(index);
      if (value === '"') {
        quote = undefined;
        token.end = index + 1;
        index += 1;
        atBoundary = false;
        continue;
      }
      if (value === escapeCharacter) {
        token.hadEscape = true;
        if (index + 1 >= end) {
          token.value += value;
          token.end = ++index;
          continue;
        }
        const next = source[index + 1];
        if (powershell || next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
          if (next !== "\n") token.value += next;
        } else {
          token.value += `${value}${next}`;
        }
        token.end = index + 2;
        index += 2;
        atBoundary = false;
        continue;
      }
      if (value === "$" && index + 1 < end && source[index + 1] === "(") {
        const nestedEnd = findDollarSubshellEnd(source, index + 2, end, powershell, escapeCharacter);
        token.value += "$(...)";
        token.end = nestedEnd;
        index = nestedEnd;
        atBoundary = false;
        continue;
      }
      if (!powershell && value === "`") {
        const nestedEnd = findBacktickEnd(source, index + 1, end);
        token.value += "$(...)";
        token.end = nestedEnd;
        index = nestedEnd;
        atBoundary = false;
        continue;
      }
      token.value += value;
      token.end = index + 1;
      index += 1;
      atBoundary = false;
      continue;
    }

    if (/\s/.test(value)) {
      finishCurrent();
      atBoundary = true;
      index += 1;
      continue;
    }
    const separator = separatorLength(source, index, end);
    if (separator) {
      finishCurrent();
      tokens.length = 0;
      atBoundary = true;
      index += separator;
      continue;
    }
    if (value === "'" || value === '"') {
      const token = ensureCurrent(index);
      quote = value === "'" ? "single" : "double";
      token.quoteStyles.add(quote);
      token.end = index + 1;
      index += 1;
      atBoundary = false;
      continue;
    }
    if (value === escapeCharacter) {
      const token = ensureCurrent(index);
      token.unquotedContent = true;
      token.hadEscape = true;
      if (index + 1 >= end) {
        token.value += value;
        token.end = ++index;
        atBoundary = false;
        continue;
      }
      const next = source[index + 1];
      if (next !== "\n") token.value += next;
      token.end = index + 2;
      index += 2;
      atBoundary = false;
      continue;
    }
    if (value === "$" && index + 1 < end && source[index + 1] === "(") {
      const token = ensureCurrent(index);
      token.unquotedContent = true;
      const nestedEnd = findDollarSubshellEnd(source, index + 2, end, powershell, escapeCharacter);
      token.value += "$(...)";
      token.end = nestedEnd;
      index = nestedEnd;
      atBoundary = false;
      continue;
    }
    if (!powershell && value === "`") {
      const token = ensureCurrent(index);
      token.unquotedContent = true;
      const nestedEnd = findBacktickEnd(source, index + 1, end);
      token.value += "$(...)";
      token.end = nestedEnd;
      index = nestedEnd;
      atBoundary = false;
      continue;
    }

    const token = ensureCurrent(index);
    token.value += value;
    token.end = index + 1;
    token.unquotedContent = true;
    index += 1;
    atBoundary = false;
  }
  finishCurrent();
  return { tokens, trailingWhitespace: atBoundary && tokens.length > 0 };
}

export function parseTerminalCommand(
  input: string,
  options: { shell?: string; cursor?: number } = {},
): TerminalParsedCommand | null {
  if (input.length > MAX_TERMINAL_PARSE_CHARS) return null;
  const end = Math.max(0, Math.min(input.length, options.cursor ?? input.length));
  const powershell = isPowerShell(options.shell);
  const escapeCharacter = powershell ? "`" : "\\";
  const start = activeCommandStart(input, end, powershell, escapeCharacter);
  const parsed = tokenizeCommand(input, start, end, powershell, escapeCharacter);
  return { ...parsed, start, end, escapeCharacter, powershell };
}

function singleQuoted(value: string, powershell: boolean): string {
  return powershell
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function doubleQuoted(value: string, powershell: boolean): string {
  return powershell
    ? `"${value.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')}"`
    : `"${value.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/"/g, '\\"')}"`;
}

function escaped(value: string, escapeCharacter: "\\" | "`"): string {
  return value.replace(/[\s\\`'"$;&|()<>]/g, (character) => `${escapeCharacter}${character}`);
}

function quoteStyleFromRaw(raw: string): TerminalQuoteStyle | undefined {
  if (raw.startsWith("'")) return "single";
  if (raw.startsWith('"')) return "double";
  return undefined;
}

export function formatTerminalTokenReplacement(
  logicalValue: string,
  token: TerminalParsedToken | undefined,
  options: { shell?: string; logicalPrefix?: string } = {},
): { value: string; encoded: boolean; quoteStyle?: TerminalQuoteStyle } {
  if (!token) return { value: logicalValue, encoded: false };
  const powershell = isPowerShell(options.shell);
  const escapeCharacter = powershell ? "`" : "\\";
  const logicalPrefix = options.logicalPrefix || "";
  let prefix = "";
  let replacement = logicalValue;
  let raw = token.raw;

  if (logicalPrefix && logicalValue.startsWith(logicalPrefix)) {
    const equals = token.raw.indexOf("=");
    if (equals >= 0) {
      prefix = token.raw.slice(0, equals + 1);
      raw = token.raw.slice(equals + 1);
      replacement = logicalValue.slice(logicalPrefix.length);
    }
  }

  const quoteStyle = quoteStyleFromRaw(raw) || (!prefix ? token.quoteStyle || token.quoteStyleHint : undefined);
  if (quoteStyle === "single") {
    return { value: `${prefix}${singleQuoted(replacement, powershell)}`, encoded: true, quoteStyle };
  }
  if (quoteStyle === "double") {
    return { value: `${prefix}${doubleQuoted(replacement, powershell)}`, encoded: true, quoteStyle };
  }
  if (token.hadEscape) {
    return { value: `${prefix}${escaped(replacement, escapeCharacter)}`, encoded: true };
  }
  return { value: logicalValue, encoded: false };
}
