import type { TerminalSuggestion } from "../types";
import {
  resolveTerminalArgumentValues,
  type TerminalArgumentValueResolver,
  type TerminalArgumentTemplate,
  type TerminalResolvedArgumentValue,
} from "./terminalArgumentResolvers";
import {
  isTerminalResourceArgumentTemplate,
  resolveTerminalResourceArgumentValues,
  type TerminalResourceCommandRunner,
} from "./terminalResourceResolvers";
import {
  formatTerminalTokenReplacement,
  parseTerminalCommand,
  type TerminalParsedCommand,
  type TerminalParsedToken,
} from "./terminalCommandParser";

export interface TerminalSignatureArgument {
  name: string;
  description?: string;
  optional?: boolean;
  variadic?: boolean;
  values?: Array<{ value: string; description?: string }>;
  templates?: TerminalArgumentTemplate[];
}

export interface TerminalSignatureOption {
  names: string[];
  description?: string;
  arguments?: TerminalSignatureArgument[];
  repeatable?: boolean;
}

export interface TerminalCommandSignature {
  name: string;
  aliases?: string[];
  description?: string;
  arguments?: TerminalSignatureArgument[];
  subcommands?: TerminalCommandSignature[];
  options?: TerminalSignatureOption[];
}

export interface TerminalSignatureMatch {
  command: TerminalCommandSignature;
  commandTokenIndex: number;
  path: string[];
}

const MAX_SIGNATURE_DEPTH = 8;
const MAX_REGISTERED_SIGNATURES = 256;
const MAX_CHILDREN_PER_COMMAND = 256;
const SAFE_SIGNATURE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:=+@%+\/-]{0,127}$/;
const SAFE_OPTION_NAME = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.:+@%+\/-]{0,127}$/;

function copyArgument(argument: TerminalSignatureArgument): TerminalSignatureArgument {
  if (!SAFE_SIGNATURE_NAME.test(argument.name)) throw new Error(`Invalid signature argument: ${argument.name}`);
  return {
    name: argument.name,
    description: argument.description,
    optional: Boolean(argument.optional),
    variadic: Boolean(argument.variadic),
    values: argument.values?.slice(0, MAX_CHILDREN_PER_COMMAND).map((value) => ({ ...value })),
    templates: argument.templates?.filter((template) => [
      "files", "folders", "files-and-folders", "cd-folders", "package-scripts", "git-branches", "git-refs",
      "docker-containers", "docker-running-containers", "docker-images", "docker-compose-services",
      "docker-contexts", "docker-volumes", "docker-networks", "kubectl-contexts", "kubectl-namespaces",
      "kubectl-resource-types", "kubectl-resource-names", "kubectl-pods", "kubectl-containers",
    ].includes(template)).slice(0, 8),
  };
}

function copyArguments(
  arguments_: TerminalSignatureArgument[] | undefined,
  owner: string,
): TerminalSignatureArgument[] | undefined {
  if (!arguments_) return undefined;
  if (arguments_.length > MAX_CHILDREN_PER_COMMAND) throw new Error(`Too many arguments for ${owner}`);
  const variadicIndex = arguments_.findIndex((argument) => argument.variadic);
  if (
    variadicIndex >= 0 &&
    (variadicIndex !== arguments_.length - 1 || arguments_.slice(variadicIndex + 1).some((argument) => argument.variadic))
  ) {
    throw new Error(`Variadic argument for ${owner} must be terminal`);
  }
  return arguments_.map(copyArgument);
}

function copyCommand(command: TerminalCommandSignature, depth = 0): TerminalCommandSignature {
  if (depth > MAX_SIGNATURE_DEPTH) throw new Error(`Command signature exceeds depth ${MAX_SIGNATURE_DEPTH}`);
  if (!SAFE_SIGNATURE_NAME.test(command.name)) throw new Error(`Invalid command signature: ${command.name}`);
  if ((command.subcommands?.length || 0) > MAX_CHILDREN_PER_COMMAND) {
    throw new Error(`Too many subcommands for ${command.name}`);
  }
  if ((command.options?.length || 0) > MAX_CHILDREN_PER_COMMAND) {
    throw new Error(`Too many options for ${command.name}`);
  }
  return {
    name: command.name,
    aliases: command.aliases?.filter((name) => SAFE_SIGNATURE_NAME.test(name)).slice(0, 32),
    description: command.description,
    arguments: copyArguments(command.arguments, command.name),
    subcommands: command.subcommands?.map((child) => copyCommand(child, depth + 1)),
    options: command.options?.map((option) => {
      const names = option.names.filter((name) => SAFE_OPTION_NAME.test(name)).slice(0, 16);
      if (!names.length) throw new Error(`Option for ${command.name} has no valid names`);
      return {
        names,
        description: option.description,
        arguments: copyArguments(option.arguments, `${command.name} ${names[0]}`),
        repeatable: Boolean(option.repeatable),
      };
    }),
  };
}

export class TerminalCommandSignatureRegistry {
  private readonly signatures = new Map<string, TerminalCommandSignature>();
  private readonly aliases = new Map<string, TerminalCommandSignature>();

  constructor(signatures: TerminalCommandSignature[] = []) {
    for (const signature of signatures) this.register(signature);
  }

  register(signature: TerminalCommandSignature) {
    if (this.signatures.size >= MAX_REGISTERED_SIGNATURES && !this.signatures.has(signature.name)) {
      throw new Error(`Command signature registry is limited to ${MAX_REGISTERED_SIGNATURES} entries`);
    }
    const safe = copyCommand(signature);
    this.signatures.set(safe.name, safe);
    for (const alias of safe.aliases || []) this.aliases.set(alias, safe);
  }

  getSignature(name: string): TerminalCommandSignature | undefined {
    return this.signatures.get(name) || this.aliases.get(name);
  }

  registeredCommands(): string[] {
    return [...this.signatures.keys()].sort((a, b) => a.localeCompare(b));
  }

}

function requiredArgumentCount(option: TerminalSignatureOption): number {
  return (option.arguments || []).filter((argument) => !argument.optional).length;
}

interface DecodedOptionToken {
  option: TerminalSignatureOption;
  name: string;
  inline: boolean;
  clustered: boolean;
}

function decodeOptionToken(command: TerminalCommandSignature, token: string): DecodedOptionToken[] {
  if (!token.startsWith("-") || token === "-" || token === "--") return [];
  const options = command.options || [];
  const equalsIndex = token.indexOf("=");
  if (equalsIndex > 0) {
    const name = token.slice(0, equalsIndex);
    const option = options.find((candidate) => candidate.names.includes(name));
    return option ? [{ option, name, inline: true, clustered: false }] : [];
  }

  const exact = options.find((candidate) => candidate.names.includes(token));
  if (exact) return [{ option: exact, name: token, inline: false, clustered: false }];
  if (token.startsWith("--")) return [];

  const characters = [...token.slice(1)];
  if (characters.length < 2) return [];
  const decoded: DecodedOptionToken[] = [];
  for (const [index, character] of characters.entries()) {
    const name = `-${character}`;
    const option = options.find((candidate) => candidate.names.includes(name));
    if (!option) return [];
    if ((option.arguments?.length || 0) > 0 && index !== characters.length - 1) return [];
    decoded.push({ option, name, inline: false, clustered: true });
  }
  return decoded;
}

function deepestMatchingSubcommand(
  inputTokens: string[],
  command: TerminalCommandSignature,
  currentTokenIndex: number,
  hasTrailingWhitespace: boolean,
  path: string[],
): TerminalSignatureMatch {
  if (!inputTokens.length) return { command, commandTokenIndex: currentTokenIndex, path };
  const searchStartIndex = currentTokenIndex;

  while (currentTokenIndex < inputTokens.length) {
    const isLastToken = currentTokenIndex === inputTokens.length - 1;
    const token = inputTokens[currentTokenIndex];
    const subcommand = (command.subcommands || []).find((candidate) =>
      candidate.name === token && (!isLastToken || hasTrailingWhitespace)
    );
    if (subcommand) {
      return deepestMatchingSubcommand(
        inputTokens,
        subcommand,
        currentTokenIndex + 1,
        hasTrailingWhitespace,
        [...path, subcommand.name],
      );
    }

    if (token === "--") break;
    if (token.startsWith("-")) {
      const decoded = decodeOptionToken(command, token);
      const valued = decoded.find((entry) => (entry.option.arguments?.length || 0) > 0);
      if (valued && !valued.inline) {
        const available = Math.max(0, inputTokens.length - currentTokenIndex - 1);
        currentTokenIndex += Math.min(requiredArgumentCount(valued.option), available);
      }
      currentTokenIndex += 1;
      continue;
    }
    break;
  }

  return { command, commandTokenIndex: searchStartIndex, path };
}

export function getMatchingTerminalSignature(
  input: string,
  registry: TerminalCommandSignatureRegistry = terminalCommandSignatureRegistry,
  options: { shell?: string } = {},
): TerminalSignatureMatch | null {
  const parsed = parseTerminalCommand(input, { shell: options.shell });
  if (!parsed) return null;
  const tokens = normalizedSignatureTokens(parsed).map((token) => token.value);
  return matchingTerminalSignatureForTokens(tokens, parsed.trailingWhitespace, registry);
}

function normalizedSignatureTokens(parsed: TerminalParsedCommand): TerminalParsedToken[] {
  const tokens = [...parsed.tokens];
  if (!parsed.powershell) {
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0].value)) tokens.shift();
  }
  return tokens;
}

function matchingTerminalSignatureForTokens(
  tokens: string[],
  trailingWhitespace: boolean,
  registry: TerminalCommandSignatureRegistry,
): TerminalSignatureMatch | null {
  const first = tokens[0];
  if (!first) return null;
  const command = registry.getSignature(first);
  if (!command) return null;
  return deepestMatchingSubcommand(
    tokens.slice(1),
    command,
    0,
    trailingWhitespace,
    [command.name],
  );
}

function fuzzyScore(query: string, ...fields: string[]): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 100;
  let best = -1;
  for (const [fieldIndex, rawField] of fields.entries()) {
    const field = rawField.toLowerCase();
    if (!field) continue;
    let score = -1;
    if (field === needle) score = 1000;
    else if (field.startsWith(needle)) score = 850 - Math.min(200, field.length - needle.length);
    else {
      const index = field.indexOf(needle);
      if (index >= 0) score = 650 - Math.min(300, index * 4);
    }
    if (score >= 0) best = Math.max(best, score - fieldIndex * 25);
  }
  return best;
}

function cursorArgument(
  command: TerminalCommandSignature,
  tokens: string[],
  startIndex: number,
  cursorTokenIndex: number,
): {
  argument?: TerminalSignatureArgument;
  usedOptions: Set<TerminalSignatureOption>;
  positionalIndex: number;
  positionals: string[];
  optionsTerminated: boolean;
} {
  const usedOptions = new Set<TerminalSignatureOption>();
  let positionalIndex = 0;
  const positionals: string[] = [];
  let optionsTerminated = false;
  for (let index = startIndex; index < cursorTokenIndex; index++) {
    const token = tokens[index];
    if (token === "--") {
      optionsTerminated = true;
      positionals.push(...tokens.slice(index + 1, cursorTokenIndex));
      positionalIndex += Math.max(0, cursorTokenIndex - index - 1);
      break;
    }
    if (token.startsWith("-")) {
      const decoded = decodeOptionToken(command, token);
      if (!decoded.length) continue;
      for (const entry of decoded) usedOptions.add(entry.option);
      const valued = decoded.find((entry) => (entry.option.arguments?.length || 0) > 0);
      if (!valued || valued.inline) continue;
      for (const argument of valued.option.arguments || []) {
        if (argument.optional) break;
        if (argument.variadic) {
          while (index + 1 < cursorTokenIndex && !tokens[index + 1].startsWith("-")) index += 1;
          if (index + 1 >= cursorTokenIndex) {
            return { argument, usedOptions, positionalIndex, positionals, optionsTerminated };
          }
          break;
        }
        if (index + 1 >= cursorTokenIndex) {
          return { argument, usedOptions, positionalIndex, positionals, optionsTerminated };
        }
        if (tokens[index + 1].startsWith("-")) break;
        index += 1;
      }
      continue;
    }
    positionals.push(token);
    positionalIndex += 1;
  }
  return { usedOptions, positionalIndex, positionals, optionsTerminated };
}

function positionalArgumentForIndex(
  command: TerminalCommandSignature,
  positionalIndex: number,
): TerminalSignatureArgument | undefined {
  const arguments_ = command.arguments || [];
  return arguments_[positionalIndex] || (
    arguments_.at(-1)?.variadic ? arguments_.at(-1) : undefined
  );
}

function shortClusterFragment(
  command: TerminalCommandSignature,
  fragment: string,
): { characters: string[]; decoded: DecodedOptionToken[] } | null {
  if (!fragment.startsWith("-") || fragment.startsWith("--") || fragment.includes("=")) return null;
  if (fragment.length > 2 && (command.options || []).some((option) => option.names.includes(fragment))) return null;
  const characters = [...fragment.slice(1)];
  if (!characters.length) return { characters, decoded: [] };
  const decoded = decodeOptionToken(command, fragment);
  if (!decoded.length || decoded.at(-1)?.option.arguments?.length) return null;
  return { characters, decoded };
}

export interface TerminalSignatureSuggestionOptions {
  registry?: TerminalCommandSignatureRegistry;
  cwd?: string;
  environment?: Record<string, string | undefined>;
  shell?: string;
  resourceValues?: TerminalResolvedArgumentValue[];
  resourceRunner?: TerminalResourceCommandRunner;
  resourceTimeoutMs?: number;
  argumentResolver?: TerminalArgumentValueResolver;
  resolvedArgumentValues?: TerminalResolvedArgumentValue[];
  disableLocalArgumentResolvers?: boolean;
}

interface PreparedTerminalSignatureSuggestions {
  parsed: TerminalParsedCommand;
  tokens: string[];
  match: TerminalSignatureMatch;
  trailingWhitespace: boolean;
  fragment: string;
  cursorTokenIndex: number;
  activeToken?: TerminalParsedToken;
  replaceStart: number;
  path: string;
  context: ReturnType<typeof cursorArgument>;
  inlineEquals: boolean;
  activeArgument?: TerminalSignatureArgument;
  positionalArgument?: TerminalSignatureArgument;
  argumentFragment: string;
  argumentPrefix: string;
}

function prepareTerminalSignatureSuggestions(
  input: string,
  options: TerminalSignatureSuggestionOptions,
): PreparedTerminalSignatureSuggestions | null {
  const parsed = parseTerminalCommand(input, { shell: options.shell });
  if (!parsed) return null;
  const parsedTokens = normalizedSignatureTokens(parsed);
  const tokens = parsedTokens.map((token) => token.value);
  const match = matchingTerminalSignatureForTokens(
    tokens,
    parsed.trailingWhitespace,
    options.registry || terminalCommandSignatureRegistry,
  );
  if (!match) return null;
  const trailingWhitespace = parsed.trailingWhitespace;
  const fragment = trailingWhitespace ? "" : tokens.at(-1) || "";
  const cursorTokenIndex = trailingWhitespace ? tokens.length : Math.max(0, tokens.length - 1);
  if (cursorTokenIndex <= match.commandTokenIndex) return null;
  const activeToken = trailingWhitespace ? undefined : parsedTokens.at(-1);
  const replaceStart = activeToken?.start ?? parsed.end;
  const path = match.path.join(" ");
  const context = cursorArgument(match.command, tokens, match.commandTokenIndex + 1, cursorTokenIndex);
  const inlineMatch = fragment.startsWith("-") && fragment.includes("=")
    ? decodeOptionToken(match.command, fragment).find((entry) => entry.inline)
    : undefined;
  const inlineEquals = Boolean(inlineMatch);
  const inlineOption = inlineMatch?.option;
  const inlineArgument = inlineOption?.arguments?.find((argument) => !argument.optional) || inlineOption?.arguments?.[0];
  const activeArgument = inlineArgument || (
    !fragment.startsWith("-") || context.optionsTerminated ? context.argument : undefined
  );
  const positionalArgument = !activeArgument && (!fragment.startsWith("-") || context.optionsTerminated)
    ? positionalArgumentForIndex(match.command, context.positionalIndex)
    : undefined;
  return {
    parsed,
    tokens,
    match,
    trailingWhitespace,
    fragment,
    cursorTokenIndex,
    activeToken,
    replaceStart,
    path,
    context,
    inlineEquals,
    activeArgument,
    positionalArgument,
    argumentFragment: inlineEquals ? fragment.slice(fragment.indexOf("=") + 1) : fragment,
    argumentPrefix: inlineEquals ? fragment.slice(0, fragment.indexOf("=") + 1) : "",
  };
}

export function getTerminalSignatureSuggestions(
  input: string,
  options: TerminalSignatureSuggestionOptions = {},
): TerminalSuggestion[] {
  const prepared = prepareTerminalSignatureSuggestions(input, options);
  if (!prepared) return [];
  const {
    parsed,
    match,
    fragment,
    activeToken,
    replaceStart,
    path,
    context,
    activeArgument,
    positionalArgument,
    argumentFragment,
    argumentPrefix,
  } = prepared;
  const argumentSuggestions = (
    argument: TerminalSignatureArgument,
    argumentFragment: string,
    prefix = "",
  ): TerminalSuggestion[] => {
    const staticValues = (argument.values || []).map((value) => ({
      ...value,
      title: value.value,
      description: value.description || argument.description || argument.name,
      source: "static" as const,
      needsShellQuoting: false,
    }));
    const dynamicValues = options.resolvedArgumentValues || (
      options.cwd && argument.templates?.length && !options.disableLocalArgumentResolvers
      ? resolveTerminalArgumentValues({
        templates: argument.templates,
        cwd: options.cwd,
        fragment: argumentFragment,
        environment: options.environment,
      })
      : []
    );
    return [...staticValues, ...dynamicValues, ...(options.resourceValues || [])].flatMap((value) => {
      const score = fuzzyScore(argumentFragment, value.value, value.description || "");
      if (score < 0) return [];
      const logicalValue = `${prefix}${value.value}`;
      const replacement = formatTerminalTokenReplacement(logicalValue, activeToken, {
        shell: options.shell,
        logicalPrefix: prefix,
      });
      return [{
        id: `signature:argument:${path}:${argument.name}:${value.value}`,
        kind: "argument" as const,
        title: value.title || value.value,
        description: value.description || argument.description || argument.name,
        value: replacement.value,
        score: score + 40,
        metadata: {
          source: "signature",
          signatureKind: "argument",
          argumentSource: value.source,
          commandPath: path,
          argument: argument.name,
          needsShellQuoting: replacement.encoded ? false : Boolean(value.needsShellQuoting),
          replacementEncoded: replacement.encoded || undefined,
          quoteStyle: replacement.quoteStyle,
          logicalValue,
          replaceStart,
          replaceEnd: parsed.end,
        },
      }];
    }).sort((a, b) => b.score - a.score);
  };
  if (activeArgument) {
    return argumentSuggestions(activeArgument, argumentFragment, argumentPrefix);
  }

  const suggestions: TerminalSuggestion[] = [];
  if (!fragment.startsWith("-") || context.optionsTerminated) {
    for (const subcommand of context.optionsTerminated ? [] : match.command.subcommands || []) {
      const score = fuzzyScore(fragment, subcommand.name, subcommand.description || "");
      if (score < 0) continue;
      const replacement = formatTerminalTokenReplacement(subcommand.name, activeToken, { shell: options.shell });
      suggestions.push({
        id: `signature:subcommand:${path}:${subcommand.name}`,
        kind: "subcommand",
        title: subcommand.name,
        description: subcommand.description || `${path} subcommand`,
        value: replacement.value,
        score: score + 60,
        metadata: {
          source: "signature",
          signatureKind: "subcommand",
          commandPath: path,
          replacementEncoded: replacement.encoded || undefined,
          quoteStyle: replacement.quoteStyle,
          logicalValue: subcommand.name,
          replaceStart,
          replaceEnd: parsed.end,
        },
      });
    }
    if (positionalArgument) suggestions.push(...argumentSuggestions(positionalArgument, fragment));
  }

  const cluster = context.optionsTerminated ? null : shortClusterFragment(match.command, fragment);
  if (cluster) {
    const included = new Set(cluster.decoded.map((entry) => entry.option));
    const current = cluster.decoded.at(-1)?.option;
    for (const option of match.command.options || []) {
      if (!option.repeatable && context.usedOptions.has(option) && !included.has(option)) continue;
      for (const name of option.names.filter((candidate) => /^-[^-]$/.test(candidate))) {
        const character = name.slice(1);
        const isCurrent = option === current && cluster.characters.at(-1) === character;
        if (included.has(option) && !isCurrent) continue;
        const logicalValue = isCurrent ? fragment : `-${cluster.characters.join("")}${character}`;
        const replacement = formatTerminalTokenReplacement(logicalValue, activeToken, { shell: options.shell });
        suggestions.push({
          id: `signature:option:${path}:${logicalValue}:${name}`,
          kind: "option",
          title: name,
          description: option.description || `${path} option`,
          value: replacement.value,
          score: (isCurrent ? 1_000 : 800) + 50,
          metadata: {
            source: "signature",
            signatureKind: "option",
            commandPath: path,
            requiredArguments: requiredArgumentCount(option),
            repeatable: Boolean(option.repeatable),
            replacementEncoded: replacement.encoded || undefined,
            quoteStyle: replacement.quoteStyle,
            logicalValue,
            replaceStart,
            replaceEnd: parsed.end,
          },
        });
      }
    }
  }

  for (const option of context.optionsTerminated ? [] : match.command.options || []) {
    if (!option.repeatable && context.usedOptions.has(option)) continue;
    for (const name of option.names) {
      if (cluster && /^-[^-]$/.test(name)) continue;
      const score = fuzzyScore(fragment, name, option.description || "");
      if (score < 0) continue;
      const replacement = formatTerminalTokenReplacement(name, activeToken, { shell: options.shell });
      suggestions.push({
        id: `signature:option:${path}:${name}`,
        kind: "option",
        title: name,
        description: option.description || `${path} option`,
        value: replacement.value,
        score: score + 50,
        metadata: {
          source: "signature",
          signatureKind: "option",
          commandPath: path,
          requiredArguments: requiredArgumentCount(option),
          repeatable: Boolean(option.repeatable),
          replacementEncoded: replacement.encoded || undefined,
          quoteStyle: replacement.quoteStyle,
          logicalValue: name,
          replaceStart,
          replaceEnd: parsed.end,
        },
      });
    }
  }
  return suggestions.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export async function getTerminalSignatureSuggestionsAsync(
  input: string,
  options: TerminalSignatureSuggestionOptions = {},
): Promise<TerminalSuggestion[]> {
  const prepared = prepareTerminalSignatureSuggestions(input, options);
  const argument = prepared?.activeArgument || prepared?.positionalArgument;
  const resourceTemplates = (argument?.templates || []).filter(isTerminalResourceArgumentTemplate);
  if (!prepared || !argument || !options.cwd || (!resourceTemplates.length && !options.argumentResolver)) {
    return getTerminalSignatureSuggestions(input, options);
  }
  const [resolvedArgumentValues, resourceValues] = await Promise.all([
    options.argumentResolver && argument.templates?.length
      ? options.argumentResolver({
          templates: argument.templates.filter((template) => !isTerminalResourceArgumentTemplate(template)),
          cwd: options.cwd,
          fragment: prepared.argumentFragment,
          environment: options.environment,
        }).catch(() => [])
      : Promise.resolve([]),
    resourceTemplates.length
      ? resolveTerminalResourceArgumentValues({
          templates: resourceTemplates,
          cwd: options.cwd,
          environment: options.environment,
          commandPath: prepared.path,
          tokens: prepared.tokens.slice(0, prepared.cursorTokenIndex),
          positionals: prepared.context.positionals,
          timeoutMs: options.resourceTimeoutMs,
          runner: options.resourceRunner,
        })
      : Promise.resolve([]),
  ]);
  return getTerminalSignatureSuggestions(input, {
    ...options,
    resourceValues,
    resolvedArgumentValues,
    disableLocalArgumentResolvers: Boolean(options.argumentResolver),
  });
}

const arg = (
  name: string,
  description?: string,
  values?: Array<string | { value: string; description?: string }>,
  optional = false,
  templates?: TerminalArgumentTemplate[],
  variadic = false,
): TerminalSignatureArgument => ({
  name,
  description,
  optional,
  variadic,
  values: values?.map((value) => typeof value === "string" ? { value } : value),
  templates,
});
const variadicArg = (
  name: string,
  description?: string,
  values?: Array<string | { value: string; description?: string }>,
  optional = false,
  templates?: TerminalArgumentTemplate[],
): TerminalSignatureArgument => arg(name, description, values, optional, templates, true);
const opt = (
  names: string | string[],
  description?: string,
  arguments_: TerminalSignatureArgument[] = [],
  repeatable = false,
): TerminalSignatureOption => ({
  names: Array.isArray(names) ? names : [names],
  description,
  arguments: arguments_,
  repeatable,
});
const cmd = (
  name: string,
  description: string,
  options: TerminalSignatureOption[] = [],
  subcommands: TerminalCommandSignature[] = [],
  arguments_: TerminalSignatureArgument[] = [],
): TerminalCommandSignature => ({ name, description, options, subcommands, arguments: arguments_ });

const outputFormats = ["json", "yaml", "name", "wide", "custom-columns", "jsonpath", "go-template"];

const CD_SIGNATURE = cmd("cd", "Change the current directory", [
  opt(["-L"], "Follow symbolic links after resolving parent components"),
  opt(["-P"], "Use the physical directory structure without following symbolic links"),
], [], [arg("directory", "Directory", undefined, true, ["cd-folders"])]);

const PUSHD_SIGNATURE = cmd("pushd", "Push a directory onto the directory stack", [
  opt(["-n"], "Change the stack without changing the current directory"),
], [], [arg("directory", "Directory", undefined, true, ["folders"])]);

const GIT_SIGNATURE = cmd("git", "Distributed version control", [
  opt(["-C"], "Run as if Git was started in this directory", [arg("path", "Working directory", undefined, false, ["folders"])], true),
  opt(["-c"], "Set a configuration value for this invocation", [arg("name=value")], true),
  opt(["--git-dir"], "Path to the repository metadata", [arg("path", undefined, undefined, false, ["folders"])]),
  opt(["--work-tree"], "Path to the working tree", [arg("path", undefined, undefined, false, ["folders"])]),
  opt(["--no-pager"], "Do not pipe output into a pager"),
  opt(["--version"], "Show Git version"),
  opt(["--help"], "Show Git help"),
], [
  cmd("add", "Add file contents to the index", [
    opt(["-A", "--all"], "Stage all changes"), opt(["-p", "--patch"], "Interactively choose hunks"),
    opt(["-n", "--dry-run"], "Preview changes"), opt(["-f", "--force"], "Allow otherwise ignored files"),
  ], [], [variadicArg("pathspec", "Files to stage", undefined, true, ["files-and-folders"])]),
  cmd("branch", "List, create, or delete branches", [
    opt(["-a", "--all"], "List local and remote branches"), opt(["-d", "--delete"], "Delete a merged branch"),
    opt(["-D"], "Force-delete a branch"), opt(["-m", "--move"], "Rename a branch"),
    opt(["-c", "--copy"], "Copy a branch"), opt(["--show-current"], "Print the current branch"),
  ], [], [arg("branch", "Branch name", undefined, true, ["git-branches"])]),
  cmd("checkout", "Switch branches or restore working-tree files", [
    opt(["-b"], "Create and switch to a new branch", [arg("branch")]),
    opt(["-B"], "Create or reset and switch to a branch", [arg("branch")]),
    opt(["--detach"], "Detach HEAD"), opt(["--orphan"], "Create an orphan branch", [arg("branch")]),
    opt(["--track"], "Set upstream tracking configuration"),
  ], [], [variadicArg("branch-or-path", "Branch or path", undefined, true, ["git-branches", "files-and-folders"])]),
  cmd("switch", "Switch branches", [
    opt(["-c", "--create"], "Create and switch to a branch", [arg("branch")]),
    opt(["-C", "--force-create"], "Create or reset and switch to a branch", [arg("branch")]),
    opt(["-d", "--detach"], "Detach HEAD"), opt(["--guess"], "Try to match a remote branch"),
  ], [], [arg("branch", "Branch to switch to", undefined, true, ["git-branches"])]),
  cmd("restore", "Restore working-tree files", [
    opt(["-s", "--source"], "Restore from a tree", [arg("tree", undefined, undefined, false, ["git-refs"])]), opt(["--staged"], "Restore the index"),
    opt(["--worktree"], "Restore the working tree"), opt(["-p", "--patch"], "Interactively choose hunks"),
  ], [], [variadicArg("pathspec", "Files to restore", undefined, true, ["files-and-folders"])]),
  cmd("commit", "Record changes to the repository", [
    opt(["-m", "--message"], "Use the supplied commit message", [arg("message")]),
    opt(["-a", "--all"], "Stage modified and deleted files"), opt(["--amend"], "Replace the previous commit"),
    opt(["--no-edit"], "Reuse the selected commit message"), opt(["-S", "--gpg-sign"], "Sign the commit", [arg("key", undefined, undefined, true)]),
  ]),
  cmd("status", "Show the working-tree status", [
    opt(["-s", "--short"], "Use the short format"), opt(["-b", "--branch"], "Show branch information"),
    opt(["--porcelain"], "Use a stable machine-readable format", [arg("version", undefined, ["v1", "v2"], true)]),
    opt(["--ignored"], "Show ignored files", [arg("mode", undefined, ["traditional", "matching", "no"], true)]),
  ]),
  cmd("log", "Show commit logs", [
    opt(["--oneline"], "Condense each commit to one line"), opt(["-n", "--max-count"], "Limit commits", [arg("count")]),
    opt(["--since"], "Show commits after a date", [arg("date")]), opt(["--author"], "Filter by author", [arg("pattern")]),
    opt(["--graph"], "Draw the commit graph"), opt(["--decorate"], "Show ref names", [arg("mode", undefined, ["short", "full", "auto", "no"], true)]),
  ]),
  cmd("diff", "Show changes between commits and the working tree", [
    opt(["--staged", "--cached"], "Compare staged changes"), opt(["--stat"], "Show a diffstat"),
    opt(["--name-only"], "Show changed paths only"), opt(["--name-status"], "Show paths and change status"),
    opt(["-w", "--ignore-all-space"], "Ignore whitespace"),
  ], [], [variadicArg("revision-or-path", "Revision or path", undefined, true, ["git-refs", "files-and-folders"])]),
  cmd("merge", "Join development histories", [
    opt(["--no-ff"], "Create a merge commit"), opt(["--squash"], "Prepare one squashed change"),
    opt(["--abort"], "Abort the current merge"), opt(["--continue"], "Continue the current merge"),
  ], [], [variadicArg("commit", "Commit or branch", undefined, true, ["git-refs"])]),
  cmd("rebase", "Reapply commits on top of another base", [
    opt(["-i", "--interactive"], "Edit the rebase plan"), opt(["--onto"], "Choose a new base", [arg("newbase")]),
    opt(["--continue"], "Continue the current rebase"), opt(["--abort"], "Abort the current rebase"),
    opt(["--skip"], "Skip the current commit"), opt(["--rebase-merges"], "Preserve merge structure"),
  ], [], [arg("upstream", "Upstream branch", undefined, true, ["git-branches"])]),
  cmd("reset", "Reset the current HEAD", [
    opt(["--soft"], "Keep index and working tree"), opt(["--mixed"], "Reset the index"),
    opt(["--hard"], "Reset index and working tree"), opt(["--keep"], "Keep local working-tree changes"),
  ], [], [arg("commit", "Commit to reset to", undefined, true, ["git-refs"])]),
  cmd("stash", "Stash working-tree changes", [], [
    cmd("push", "Save local modifications", [opt(["-u", "--include-untracked"], "Include untracked files"), opt(["-m", "--message"], "Stash message", [arg("message")])]),
    cmd("pop", "Apply and remove a stash", [opt(["--index"], "Try to restore the index")], [], [arg("stash", undefined, undefined, true)]),
    cmd("apply", "Apply a stash", [opt(["--index"], "Try to restore the index")], [], [arg("stash", undefined, undefined, true)]),
    cmd("list", "List stashes"), cmd("show", "Inspect a stash", [opt(["-p", "--patch"], "Show the full diff")]),
    cmd("drop", "Delete a stash"), cmd("clear", "Delete all stashes"),
    cmd("branch", "Create a branch from a stash", [], [], [arg("branch"), arg("stash", undefined, undefined, true)]),
  ]),
  cmd("remote", "Manage tracked repositories", [], [
    cmd("add", "Add a remote", [opt(["-f", "--fetch"], "Fetch after adding")], [], [arg("name"), arg("url")]),
    cmd("remove", "Remove a remote", [], [], [arg("name")]), cmd("rename", "Rename a remote", [], [], [arg("old"), arg("new")]),
    cmd("get-url", "Get a remote URL", [opt(["--all"], "Show all URLs")], [], [arg("name")]),
    cmd("set-url", "Change a remote URL", [opt(["--add"], "Add another URL"), opt(["--delete"], "Delete matching URLs")], [], [arg("name"), arg("url")]),
    cmd("show", "Show remote information", [], [], [arg("name", undefined, undefined, true)]),
    cmd("prune", "Delete stale remote-tracking references", [opt(["--dry-run"], "Preview deletions")], [], [arg("name")]),
    cmd("update", "Fetch updates for remotes"),
  ]),
  cmd("tag", "Create, list, or delete tags", [opt(["-a", "--annotate"], "Create an annotated tag"), opt(["-d", "--delete"], "Delete tags"), opt(["-m", "--message"], "Tag message", [arg("message")])]),
  cmd("fetch", "Download objects and refs", [opt(["--all"], "Fetch all remotes"), opt(["-p", "--prune"], "Prune stale refs"), opt(["--tags"], "Fetch tags")]),
  cmd("pull", "Fetch and integrate changes", [opt(["--rebase"], "Rebase after fetching"), opt(["--ff-only"], "Allow only fast-forward updates")]),
  cmd("push", "Update remote refs", [opt(["-u", "--set-upstream"], "Set upstream tracking"), opt(["--force-with-lease"], "Safely force an update"), opt(["--tags"], "Push tags"), opt(["--delete"], "Delete remote refs")]),
  cmd("clone", "Clone a repository", [opt(["-b", "--branch"], "Checkout a branch", [arg("branch")]), opt(["--depth"], "Create a shallow clone", [arg("depth")]), opt(["--recurse-submodules"], "Initialize submodules")], [], [arg("repository"), arg("directory", undefined, undefined, true)]),
  cmd("init", "Create an empty repository", [opt(["-b", "--initial-branch"], "Initial branch name", [arg("branch")]), opt(["--bare"], "Create a bare repository")], [], [arg("directory", undefined, undefined, true)]),
]);

const packageManagerCommands = (manager: string): TerminalCommandSignature => cmd(manager, `${manager} package manager`, [
  opt(["--version"], `Show the ${manager} version`), opt(["--help"], "Show help"),
], [
  cmd("install", "Install dependencies", [opt(["--frozen-lockfile"], "Do not update the lockfile"), opt(["--production"], "Install production dependencies only")], [], [variadicArg("package", undefined, undefined, true)]),
  cmd("add", "Add a dependency", [opt(["-D", "--save-dev"], "Add to development dependencies"), opt(["-g", "--global"], "Install globally"), opt(["--exact"], "Pin the exact version")], [], [variadicArg("package", undefined, undefined, true)]),
  cmd("remove", "Remove a dependency", [opt(["-g", "--global"], "Remove a global package")], [], [variadicArg("package", undefined, undefined, true)]),
  cmd("run", "Run a package script", [], [], [arg("script", "Script name", undefined, false, ["package-scripts"])]),
  cmd("test", "Run tests"), cmd("start", "Run the start script"), cmd("build", "Run the build script"),
  cmd("init", "Create a package manifest", [opt(["-y", "--yes"], "Accept defaults")]),
  cmd("publish", "Publish a package", [opt(["--tag"], "Distribution tag", [arg("tag")]), opt(["--access"], "Package access", [arg("access", undefined, ["public", "restricted"])])]),
  cmd("version", "Change the package version", [], [], [arg("version", undefined, ["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease"])]),
  cmd("config", "Manage configuration", [], [cmd("get", "Read a value"), cmd("set", "Set a value"), cmd("delete", "Delete a value"), cmd("list", "List values")]),
]);

const NPM_SIGNATURE = packageManagerCommands("npm");
const PNPM_SIGNATURE = packageManagerCommands("pnpm");
const YARN_SIGNATURE = packageManagerCommands("yarn");

const BUN_SIGNATURE = cmd("bun", "JavaScript runtime and toolkit", [opt(["--version"], "Show the Bun version")], [
  cmd("run", "Run a script or file", [], [], [arg("script-or-file", undefined, undefined, false, ["package-scripts", "files-and-folders"])]),
  cmd("install", "Install dependencies", [opt(["--frozen-lockfile"], "Do not update the lockfile")]),
  cmd("add", "Add a dependency", [opt(["-d", "--dev"], "Add to development dependencies"), opt(["-g", "--global"], "Install globally")], [], [variadicArg("package", undefined, undefined, true)]),
  cmd("remove", "Remove a dependency", [], [], [variadicArg("package", undefined, undefined, true)]),
  cmd("test", "Run tests", [opt(["--watch"], "Watch for changes"), opt(["--coverage"], "Collect coverage")]),
  cmd("build", "Bundle files", [opt(["--outdir"], "Output directory", [arg("directory", undefined, undefined, false, ["folders"])]), opt(["--target"], "Build target", [arg("target", undefined, ["browser", "bun", "node"])])]),
  cmd("x", "Run a package binary", [], [], [arg("package")]), cmd("create", "Create a project from a template"),
]);

const DOCKER_SIGNATURE = cmd("docker", "Build and run containers", [
  opt(["--context"], "Select a Docker context", [arg("context", undefined, undefined, false, ["docker-contexts"])]), opt(["--host", "-H"], "Daemon socket", [arg("socket")]),
  opt(["--config"], "Client configuration directory", [arg("directory")]),
], [
  cmd("build", "Build an image", [opt(["-t", "--tag"], "Image name and tag", [arg("name")], true), opt(["-f", "--file"], "Dockerfile path", [arg("path", undefined, undefined, false, ["files"])]), opt(["--build-arg"], "Build variable", [arg("name=value")], true), opt(["--no-cache"], "Do not use cache")], [], [arg("context", undefined, undefined, true, ["folders"])]),
  cmd("run", "Run a new container", [opt(["-d", "--detach"], "Run in the background"), opt(["-it"], "Allocate an interactive TTY"), opt(["--name"], "Container name", [arg("name")]), opt(["-p", "--publish"], "Publish a port", [arg("host:container")], true), opt(["-v", "--volume"], "Mount a volume", [arg("source:target")], true), opt(["-e", "--env"], "Set an environment variable", [arg("name=value")], true), opt(["--rm"], "Remove the container when it exits")], [], [arg("image", undefined, undefined, false, ["docker-images"]), variadicArg("command", undefined, undefined, true)]),
  cmd("exec", "Run a command in a container", [opt(["-it"], "Allocate an interactive TTY"), opt(["-u", "--user"], "Run as a user", [arg("user")]), opt(["-w", "--workdir"], "Working directory", [arg("directory")])], [], [arg("container", undefined, undefined, false, ["docker-running-containers"]), variadicArg("command")]),
  cmd("ps", "List containers", [opt(["-a", "--all"], "Show stopped containers"), opt(["-q", "--quiet"], "Show IDs only"), opt(["--filter"], "Filter output", [arg("filter")], true), opt(["--format"], "Format output", [arg("template")])]),
  cmd("images", "List images", [opt(["-a", "--all"], "Show intermediate images"), opt(["-q", "--quiet"], "Show IDs only")]),
  cmd("pull", "Pull an image", [], [], [arg("image", undefined, undefined, false, ["docker-images"])]), cmd("push", "Push an image", [], [], [arg("image", undefined, undefined, false, ["docker-images"])]),
  cmd("logs", "Fetch container logs", [opt(["-f", "--follow"], "Follow output"), opt(["--tail"], "Number of lines", [arg("count")]), opt(["-t", "--timestamps"], "Show timestamps")], [], [arg("container", undefined, undefined, false, ["docker-containers"])]),
  cmd("stop", "Stop containers", [], [], [variadicArg("container", undefined, undefined, true, ["docker-running-containers"])]), cmd("start", "Start containers", [], [], [variadicArg("container", undefined, undefined, true, ["docker-containers"])]),
  cmd("rm", "Remove containers", [opt(["-f", "--force"], "Force removal"), opt(["-v", "--volumes"], "Remove anonymous volumes")], [], [variadicArg("container", undefined, undefined, true, ["docker-containers"])]),
  cmd("rmi", "Remove images", [opt(["-f", "--force"], "Force removal")], [], [variadicArg("image", undefined, undefined, true, ["docker-images"])]),
  cmd("compose", "Manage multi-container applications", [opt(["-f", "--file"], "Compose file", [arg("path", undefined, undefined, false, ["files"])], true), opt(["-p", "--project-name"], "Project name", [arg("name")])], [
    cmd("up", "Create and start services", [opt(["-d", "--detach"], "Run in the background"), opt(["--build"], "Build before starting"), opt(["--remove-orphans"], "Remove orphaned containers")], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]),
    cmd("down", "Stop and remove resources", [opt(["-v", "--volumes"], "Remove named volumes"), opt(["--remove-orphans"], "Remove orphaned containers")]),
    cmd("build", "Build services", [opt(["--no-cache"], "Do not use cache"), opt(["--pull"], "Always pull newer images")], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]),
    cmd("logs", "View service logs", [opt(["-f", "--follow"], "Follow output"), opt(["--tail"], "Number of lines", [arg("count")])], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]),
    cmd("ps", "List service containers", [opt(["-a", "--all"], "Show stopped containers"), opt(["-q", "--quiet"], "Show IDs only")], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]),
    cmd("run", "Run a one-off command", [opt(["--rm"], "Remove after exit"), opt(["--no-deps"], "Do not start linked services")], [], [arg("service", undefined, undefined, false, ["docker-compose-services"]), variadicArg("command", undefined, undefined, true)]),
    cmd("exec", "Run a command in a service container", [opt(["-T"], "Disable TTY allocation")], [], [arg("service", undefined, undefined, false, ["docker-compose-services"]), variadicArg("command")]),
    cmd("pull", "Pull service images", [], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]), cmd("restart", "Restart services", [], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]), cmd("start", "Start services", [], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]),
    cmd("stop", "Stop services", [], [], [variadicArg("service", undefined, undefined, true, ["docker-compose-services"])]), cmd("config", "Validate and render the model"),
  ]),
  cmd("container", "Manage containers", [], [cmd("ls", "List containers"), cmd("inspect", "Inspect containers", [], [], [variadicArg("container", undefined, undefined, false, ["docker-containers"])]), cmd("prune", "Remove stopped containers")]),
  cmd("image", "Manage images", [], [cmd("ls", "List images"), cmd("inspect", "Inspect images", [], [], [variadicArg("image", undefined, undefined, false, ["docker-images"])]), cmd("rm", "Remove images", [], [], [variadicArg("image", undefined, undefined, false, ["docker-images"])]), cmd("prune", "Remove unused images")]),
  cmd("volume", "Manage volumes", [], [cmd("create", "Create a volume"), cmd("ls", "List volumes"), cmd("inspect", "Inspect volumes", [], [], [variadicArg("volume", undefined, undefined, false, ["docker-volumes"])]), cmd("rm", "Remove volumes", [], [], [variadicArg("volume", undefined, undefined, false, ["docker-volumes"])]), cmd("prune", "Remove unused volumes")]),
  cmd("network", "Manage networks", [], [cmd("create", "Create a network"), cmd("ls", "List networks"), cmd("inspect", "Inspect networks", [], [], [variadicArg("network", undefined, undefined, false, ["docker-networks"])]), cmd("rm", "Remove networks", [], [], [variadicArg("network", undefined, undefined, false, ["docker-networks"])]), cmd("prune", "Remove unused networks")]),
]);

const kubectlObjectOptions = [
  opt(["-n", "--namespace"], "Namespace scope", [arg("namespace", undefined, undefined, false, ["kubectl-namespaces"])]),
  opt(["-o", "--output"], "Output format", [arg("format", undefined, outputFormats)]),
  opt(["-l", "--selector"], "Label selector", [arg("selector")]),
  opt(["--context"], "Kubeconfig context", [arg("context")]),
];
const KUBECTL_SIGNATURE = cmd("kubectl", "Control Kubernetes clusters", [
  opt(["-n", "--namespace"], "Namespace scope", [arg("namespace", undefined, undefined, false, ["kubectl-namespaces"])]),
  opt(["--context"], "Kubeconfig context", [arg("context", undefined, undefined, false, ["kubectl-contexts"])]),
  opt(["--kubeconfig"], "Kubeconfig file", [arg("path", undefined, undefined, false, ["files"])]),
  opt(["--cluster"], "Kubeconfig cluster", [arg("cluster")]),
  opt(["--user"], "Kubeconfig user", [arg("user")]),
], [
  cmd("get", "Display resources", kubectlObjectOptions, [], [arg("resource", undefined, undefined, false, ["kubectl-resource-types"]), variadicArg("name", undefined, undefined, true, ["kubectl-resource-names"])]),
  cmd("describe", "Show resource details", kubectlObjectOptions, [], [arg("resource", undefined, undefined, false, ["kubectl-resource-types"]), variadicArg("name", undefined, undefined, true, ["kubectl-resource-names"])]),
  cmd("apply", "Apply configuration", [opt(["-f", "--filename"], "File or directory", [arg("path", undefined, undefined, false, ["files-and-folders"])], true), opt(["-k", "--kustomize"], "Kustomization directory", [arg("directory", undefined, undefined, false, ["folders"])]), opt(["--server-side"], "Use server-side apply"), opt(["--dry-run"], "Preview mode", [arg("mode", undefined, ["none", "client", "server"])])]),
  cmd("delete", "Delete resources", [...kubectlObjectOptions, opt(["-f", "--filename"], "File or directory", [arg("path", undefined, undefined, false, ["files-and-folders"])], true), opt(["--all"], "Delete all resources of the selected type")], [], [arg("resource", undefined, undefined, true, ["kubectl-resource-types"]), variadicArg("name", undefined, undefined, true, ["kubectl-resource-names"])]),
  cmd("create", "Create a resource", [opt(["-f", "--filename"], "File or directory", [arg("path", undefined, undefined, false, ["files-and-folders"])], true), opt(["--dry-run"], "Preview mode", [arg("mode", undefined, ["none", "client", "server"])])], [cmd("deployment", "Create a deployment"), cmd("service", "Create a service"), cmd("namespace", "Create a namespace"), cmd("secret", "Create a secret"), cmd("configmap", "Create a config map"), cmd("job", "Create a job")]),
  cmd("edit", "Edit a resource", kubectlObjectOptions, [], [arg("resource", undefined, undefined, false, ["kubectl-resource-types"]), arg("name", undefined, undefined, true, ["kubectl-resource-names"])]),
  cmd("logs", "Print container logs", [opt(["-f", "--follow"], "Follow logs"), opt(["-c", "--container"], "Container name", [arg("container", undefined, undefined, false, ["kubectl-containers"])]), opt(["--tail"], "Number of lines", [arg("count")]), opt(["--previous"], "Previous container instance"), opt(["-n", "--namespace"], "Namespace", [arg("namespace", undefined, undefined, false, ["kubectl-namespaces"])])], [], [arg("pod", undefined, undefined, false, ["kubectl-pods"])]),
  cmd("exec", "Run a command in a container", [opt(["-it"], "Allocate an interactive TTY"), opt(["-c", "--container"], "Container name", [arg("container", undefined, undefined, false, ["kubectl-containers"])]), opt(["-n", "--namespace"], "Namespace", [arg("namespace", undefined, undefined, false, ["kubectl-namespaces"])])], [], [arg("pod", undefined, undefined, false, ["kubectl-pods"]), variadicArg("command")]),
  cmd("port-forward", "Forward local ports", [opt(["-n", "--namespace"], "Namespace", [arg("namespace", undefined, undefined, false, ["kubectl-namespaces"])]), opt(["--address"], "Listening address", [arg("address")], true)], [], [arg("resource", undefined, undefined, false, ["kubectl-pods"]), variadicArg("port")]),
  cmd("config", "Manage kubeconfig", [], [cmd("current-context", "Show the current context"), cmd("get-contexts", "List contexts", [], [], [arg("context", undefined, undefined, true, ["kubectl-contexts"])]), cmd("use-context", "Select a context", [], [], [arg("context", undefined, undefined, false, ["kubectl-contexts"])]), cmd("set-context", "Change a context", [], [], [arg("context", undefined, undefined, true, ["kubectl-contexts"])]), cmd("delete-context", "Delete a context", [], [], [arg("context", undefined, undefined, false, ["kubectl-contexts"])]), cmd("rename-context", "Rename a context", [], [], [arg("old", undefined, undefined, false, ["kubectl-contexts"]), arg("new")]), cmd("view", "Show merged kubeconfig")]),
  cmd("rollout", "Manage workload rollouts", [], [cmd("status", "Show rollout status"), cmd("restart", "Restart a resource"), cmd("history", "Show rollout history"), cmd("undo", "Undo a rollout"), cmd("pause", "Pause a rollout"), cmd("resume", "Resume a rollout")]),
  cmd("scale", "Set a workload size", [opt(["--replicas"], "Replica count", [arg("count")]), opt(["-n", "--namespace"], "Namespace", [arg("namespace")])]),
  cmd("top", "Show resource usage", [], [cmd("node", "Show node usage"), cmd("pod", "Show pod usage", [], [], [variadicArg("pod", undefined, undefined, true, ["kubectl-pods"])])]),
  cmd("explain", "Show resource documentation", [opt(["--recursive"], "Show all fields")]),
  cmd("api-resources", "List available resource types"), cmd("cluster-info", "Show cluster information"),
]);

const GH_SIGNATURE = cmd("gh", "GitHub command-line interface", [
  opt(["--repo", "-R"], "Select a repository", [arg("owner/repo")]), opt(["--hostname"], "GitHub hostname", [arg("host")]),
], [
  cmd("auth", "Authenticate with GitHub", [], [cmd("login", "Log in"), cmd("logout", "Log out"), cmd("status", "Show authentication status"), cmd("refresh", "Refresh credentials")]),
  cmd("repo", "Manage repositories", [], [cmd("clone", "Clone a repository"), cmd("create", "Create a repository"), cmd("fork", "Fork a repository"), cmd("view", "View a repository"), cmd("list", "List repositories"), cmd("sync", "Sync a fork")]),
  cmd("pr", "Manage pull requests", [], [
    cmd("create", "Create a pull request", [opt(["--draft"], "Create as draft"), opt(["--title"], "Pull request title", [arg("title")]), opt(["--body"], "Pull request body", [arg("body")]), opt(["--base"], "Base branch", [arg("branch")])]),
    cmd("checkout", "Checkout a pull request"), cmd("view", "View a pull request"), cmd("list", "List pull requests"),
    cmd("status", "Show pull request status"), cmd("checks", "Show checks"), cmd("diff", "Show the diff"),
    cmd("merge", "Merge a pull request"), cmd("review", "Review a pull request"), cmd("close", "Close a pull request"), cmd("reopen", "Reopen a pull request"),
  ]),
  cmd("issue", "Manage issues", [], [cmd("create", "Create an issue"), cmd("view", "View an issue"), cmd("list", "List issues"), cmd("status", "Show issue status"), cmd("close", "Close an issue"), cmd("reopen", "Reopen an issue"), cmd("develop", "Create a linked branch")]),
  cmd("workflow", "Manage workflows", [], [cmd("list", "List workflows"), cmd("view", "View a workflow"), cmd("run", "Run a workflow"), cmd("enable", "Enable a workflow"), cmd("disable", "Disable a workflow")]),
  cmd("run", "Manage workflow runs", [], [cmd("list", "List runs"), cmd("view", "View a run"), cmd("watch", "Watch a run"), cmd("rerun", "Rerun a workflow"), cmd("cancel", "Cancel a run"), cmd("download", "Download artifacts")]),
  cmd("release", "Manage releases", [], [cmd("create", "Create a release"), cmd("view", "View a release"), cmd("list", "List releases"), cmd("download", "Download assets"), cmd("delete", "Delete a release")]),
  cmd("api", "Make an authenticated API request", [opt(["--method", "-X"], "HTTP method", [arg("method", undefined, ["GET", "POST", "PUT", "PATCH", "DELETE"])]), opt(["--field", "-f"], "Add a string parameter", [arg("key=value")], true), opt(["--raw-field", "-F"], "Add a typed parameter", [arg("key=value")], true), opt(["--paginate"], "Request all pages")]),
]);

export const terminalCommandSignatureRegistry = new TerminalCommandSignatureRegistry([
  CD_SIGNATURE,
  PUSHD_SIGNATURE,
  GIT_SIGNATURE,
  NPM_SIGNATURE,
  PNPM_SIGNATURE,
  YARN_SIGNATURE,
  BUN_SIGNATURE,
  DOCKER_SIGNATURE,
  KUBECTL_SIGNATURE,
  GH_SIGNATURE,
]);
