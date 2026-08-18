const BARE_DOMAIN_TLDS =
  "ai|app|au|biz|ca|cloud|co|com|de|dev|fr|gg|in|info|io|jp|me|net|online|org|run|sh|site|so|studio|systems|tech|to|tools|tv|uk|us|xyz";
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const URL_TAIL = "(?::\\d{1,5})?(?:[/?#][^\\s<>{}\\[\\]\\\"'`]*)?";
const BARE_DOMAIN_SOURCE = `(?:${DOMAIN_LABEL}\\.)+(?:${BARE_DOMAIN_TLDS})${URL_TAIL}`;
const BARE_DOMAIN_URL_RE = new RegExp(`^${BARE_DOMAIN_SOURCE}$`, "i");
const WEB_URL_RE = new RegExp(
  `(?:https?:\\/\\/[^\\s<>{}\\[\\]\\\"'\`]+|\\bwww\\.[^\\s<>{}\\[\\]\\\"'\`]+|\\b(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(?::\\d{1,5})(?:\\/[^\\s<>{}\\[\\]\\\"'\`]*)?|(?<![a-z0-9@._-])${BARE_DOMAIN_SOURCE})`,
  "gi",
);

function trimTrailingPunctuation(value: string): string {
  let next = value.trim();
  while (/[.,;:!?"'}\]]$/.test(next)) next = next.slice(0, -1);

  // Keep balanced closing parentheses that are part of the URL, but drop
  // sentence punctuation such as "See https://example.com)."
  while (next.endsWith(")")) {
    const opens = (next.match(/\(/g) || []).length;
    const closes = (next.match(/\)/g) || []).length;
    if (closes <= opens) break;
    next = next.slice(0, -1);
  }
  return next;
}

export function normalizeWebUrl(raw: string): string | null {
  const cleaned = trimTrailingPunctuation(raw);
  if (!cleaned) return null;

  const isHttp = /^https?:\/\//i.test(cleaned);
  const isWww = /^www\./i.test(cleaned);
  const isLocal = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})(?:\/|$)/i.test(cleaned);
  const isBareDomain = BARE_DOMAIN_URL_RE.test(cleaned);
  if (!isHttp && !isWww && !isLocal && !isBareDomain) return null;

  const withProtocol = isHttp
    ? cleaned
    : isWww || isBareDomain
      ? `https://${cleaned}`
      : `http://${cleaned}`;

  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "0.0.0.0") url.hostname = "localhost";
    return url.toString();
  } catch {
    return null;
  }
}

export function extractWebUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  WEB_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WEB_URL_RE.exec(text)) !== null) {
    const url = normalizeWebUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function isGoogleAuthUrl(raw: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase() === "accounts.google.com";
  } catch {
    return false;
  }
}
