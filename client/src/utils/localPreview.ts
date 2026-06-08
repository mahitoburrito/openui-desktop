const ANSI_ESCAPE_RE =
  /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

const LOCAL_PREVIEW_URL_RE =
  /\b(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#][^\s"'`<>)\]]*)?|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}(?:[/?#][^\s"'`<>)\]]*)?)/gi;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function stripAnsiForUrlScan(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

function stripUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?'"`)>}\]]+$/, "");
}

export function normalizeLocalPreviewUrl(raw: string): string | null {
  const cleaned = stripUrlPunctuation(raw.trim());
  if (!cleaned) return null;

  const withProtocol = /^https?:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`;

  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!LOCAL_HOSTS.has(hostname)) return null;

    if (hostname === "0.0.0.0") {
      url.hostname = "localhost";
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function extractLocalPreviewUrls(output: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  LOCAL_PREVIEW_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCAL_PREVIEW_URL_RE.exec(output)) !== null) {
    const url = normalizeLocalPreviewUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}
