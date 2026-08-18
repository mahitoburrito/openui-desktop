export const MAX_WEB_NAVIGATION_URL_CHARS = 8192;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const LOCALHOST_INPUT = /^localhost(?::\d+)?(?:[/?#]|$)/iu;
const IPV4_INPUT = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/u;
const IPV6_INPUT = /^\[[0-9a-f:.]+\](?::\d+)?(?:[/?#]|$)/iu;

function boundedNavigationInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (
    input.length > MAX_WEB_NAVIGATION_URL_CHARS ||
    CONTROL_CHARACTERS.test(input) ||
    input.includes("\\")
  ) {
    return null;
  }
  const value = input.trim();
  if (!value) return null;
  return value;
}

/**
 * Validate a fully-qualified URL before it reaches an Electron navigation or
 * shell.openExternal boundary. Keep this stricter than Chromium's parser:
 * terminal output and embedded web pages are untrusted inputs.
 */
export function safeWebNavigationUrl(input: unknown): string | null {
  const value = boundedNavigationInput(input);
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.href.length > MAX_WEB_NAVIGATION_URL_CHARS
  ) {
    return null;
  }
  return parsed.href;
}

/** Normalize user-entered browser locations, then apply the same boundary. */
export function normalizeWebNavigationInput(input: unknown): string | null {
  const value = boundedNavigationInput(input);
  if (!value || /^[/?#]/u.test(value)) return null;

  if (/^https?:\/\//iu.test(value)) {
    return safeWebNavigationUrl(value);
  }
  if (LOCALHOST_INPUT.test(value) || IPV4_INPUT.test(value) || IPV6_INPUT.test(value)) {
    return safeWebNavigationUrl(`http://${value}`);
  }
  if (EXPLICIT_SCHEME.test(value)) return null;
  return safeWebNavigationUrl(`https://${value}`);
}
