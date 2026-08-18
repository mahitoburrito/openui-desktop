export interface RedactionResult {
  text: string;
  sensitive: boolean;
  secrets: string[];
}

const REDACTED = "[REDACTED]";
const MAX_REMEMBERED_SECRET_CHARS = 8192;
const SHELL_VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"';|&,}]+)`;
const SENSITIVE_NAME = /(?:^|[._-])(?:api[_-]?key|access[_-]?(?:key|token)|auth[_-]?token|client[_-]?secret|private[_-]?key|refresh[_-]?token|session[_-]?token|token|secret|password|passwd|passphrase|credential|pass)(?:$|[._-])/i;
const EXTERNAL_SECRET_REFERENCE = /(?:^|[._-])(?:stdin|file|path|env|fd)$/i;

function uniqueSecrets(values: string[]): string[] {
  return [...new Set(values.filter(
    (value) => value.length >= 4 && value.length <= MAX_REMEMBERED_SECRET_CHARS && value !== REDACTED,
  ))].slice(0, 50);
}

function normalizedSensitiveName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function isSensitiveName(value: string): boolean {
  return SENSITIVE_NAME.test(normalizedSensitiveName(value));
}

function isExternalSecretReference(value: string): boolean {
  return EXTERNAL_SECRET_REFERENCE.test(normalizedSensitiveName(value));
}

function rawSecretValue(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

function redactedRawValue(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return `${value[0]}${REDACTED}${value[0]}`;
  }
  return REDACTED;
}

/**
 * Redacts common secret-bearing shell and structured-text syntax before
 * terminal data reaches history, search, sharing, or disk. Names and harmless
 * prefixes remain readable; credential values do not.
 */
export function redactTerminalText(value: string, knownSecrets: readonly string[] = []): RedactionResult {
  const secrets: string[] = [];
  let sensitive = false;
  let text = value;

  const remember = (secret: string) => {
    if (!secret || secret === REDACTED) return;
    sensitive = true;
    if (secret.length >= 4 && secret.length <= MAX_REMEMBERED_SECRET_CHARS) secrets.push(secret);
  };
  const replaceRawValue = (raw: string): string => {
    remember(rawSecretValue(raw));
    return redactedRawValue(raw);
  };

  for (const secret of knownSecrets) {
    if (secret.length < 4 || secret.length > MAX_REMEMBERED_SECRET_CHARS || !text.includes(secret)) continue;
    text = text.split(secret).join(REDACTED);
    remember(secret);
  }

  // Shell assignments, dotenv values, JSON-like fields, and header-shaped
  // key/value pairs. Quoted values may contain whitespace and escaped quotes.
  const assignment = new RegExp(
    `((?:^|[\\s,{])["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*)(${SHELL_VALUE})`,
    "g",
  );
  text = text.replace(assignment, (match, prefix: string, name: string, raw: string) => {
    if (!isSensitiveName(name)) return match;
    return `${prefix}${replaceRawValue(raw)}`;
  });

  // Long-form secret flags and descriptive short flags. Source selectors such
  // as --password-stdin and --token-file name a transport, not a secret value.
  const option = new RegExp(
    `((?:^|\\s)--?([A-Za-z][A-Za-z0-9_.-]*)(?:=|\\s+))(${SHELL_VALUE})`,
    "g",
  );
  text = text.replace(option, (match, prefix: string, name: string, raw: string) => {
    if (!isSensitiveName(name) || isExternalSecretReference(name)) return match;
    return `${prefix}${replaceRawValue(raw)}`;
  });

  const replaceScopedOption = (command: string, flag: string) => {
    const scoped = new RegExp(
      `(\\b(?:${command})\\b[^;|&\\r\\n]*?\\s(?:${flag})(?:=|\\s+))(${SHELL_VALUE})`,
      "gi",
    );
    text = text.replace(scoped, (_match, prefix: string, raw: string) => `${prefix}${replaceRawValue(raw)}`);
  };
  replaceScopedOption(String.raw`(?:docker|podman)\s+login`, String.raw`-p`);
  replaceScopedOption(String.raw`sshpass`, String.raw`-p`);
  replaceScopedOption(String.raw`redis-cli`, String.raw`-a`);

  // Curl/wget userinfo flags retain the non-secret username when possible.
  const userInfoOption = new RegExp(
    `(\\b(?:curl|wget)\\b[^;|&\\r\\n]*?\\s(?:-u|--user|--proxy-user)(?:=|\\s+))(${SHELL_VALUE})`,
    "gi",
  );
  text = text.replace(userInfoOption, (match, prefix: string, raw: string) => {
    const unquoted = rawSecretValue(raw);
    const separator = unquoted.indexOf(":");
    if (separator < 0) return match;
    remember(unquoted.slice(separator + 1));
    const redacted = `${unquoted.slice(0, separator + 1)}${REDACTED}`;
    const quote = raw.length >= 2 && raw.at(-1) === raw[0] && (raw[0] === '"' || raw[0] === "'")
      ? raw[0]
      : "";
    return `${prefix}${quote}${redacted}${quote}`;
  });

  // MySQL-compatible clients accept a password attached directly to -p.
  const mysqlPassword = /(\b(?:mysql|mariadb)\b[^;|&\r\n]*?\s-p)([^\s;|&]+)/gi;
  text = text.replace(mysqlPassword, (_match, prefix: string, secret: string) => {
    remember(secret);
    return `${prefix}${REDACTED}`;
  });

  // OpenSSL passphrase sources use pass:<literal>; env/file/fd/stdin sources
  // name an external source and do not expose that source's value here.
  const opensslPassphrase = new RegExp(
    `(\\bopenssl\\b[^;|&\\r\\n]*?\\s-(?:pass|passin|passout)(?:=|\\s+))(${SHELL_VALUE})`,
    "gi",
  );
  text = text.replace(opensslPassphrase, (match, prefix: string, raw: string) => {
    const unquoted = rawSecretValue(raw);
    if (/^(?:env|file|fd|stdin):/i.test(unquoted)) return match;
    const literal = unquoted.replace(/^pass:/i, "");
    remember(literal);
    const replacement = /^pass:/i.test(unquoted) ? `pass:${REDACTED}` : REDACTED;
    const quote = raw.length >= 2 && raw.at(-1) === raw[0] && (raw[0] === '"' || raw[0] === "'")
      ? raw[0]
      : "";
    return `${prefix}${quote}${replacement}${quote}`;
  });

  // Authentication headers are frequently embedded inside a quoted -H value.
  text = text.replace(
    /(\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic)\s+)([A-Za-z0-9._~+/=-]{4,})/gi,
    (_match, prefix: string, secret: string) => {
      remember(secret);
      return `${prefix}${REDACTED}`;
    },
  );

  // URI userinfo. Preserve the username so the saved command remains useful.
  text = text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    (_match, prefix: string, secret: string, suffix: string) => {
      remember(secret);
      return `${prefix}${REDACTED}${suffix}`;
    },
  );

  // Provider formats are deliberately independent of variable/flag names.
  const patterns: RegExp[] = [
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}\b/g,
    /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{12,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bxapp-[0-9]+-[A-Za-z0-9_]+-[0-9]+-[A-Fa-f0-9]+\b/g,
    /\b(?:hf|fw|npm)_[A-Za-z0-9_-]{12,}\b/g,
    /\b(?:AKIA|A3T|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{12,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\b(?:r|s)k_(?:test|live)_[A-Za-z0-9]{20,}\b/g,
    /\bwk-[0-9]+\.[A-Fa-f0-9.-]{6,}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, (secret) => {
      remember(secret);
      return REDACTED;
    });
  }

  // PEM private-key material can span many terminal lines. Do not retain the
  // body as a known secret: it may be megabytes long, but the block is still
  // marked sensitive and its content is removed.
  text = text.replace(
    /(-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----)[\s\S]*?(-----END \2-----)/g,
    (_match, begin: string, _label: string, end: string) => {
      sensitive = true;
      return `${begin}\n${REDACTED}\n${end}`;
    },
  );

  return { text, sensitive, secrets: uniqueSecrets(secrets) };
}
