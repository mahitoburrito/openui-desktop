export function normalizeBrowserUrl(input: string): string {
  const url = input.trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (/^localhost(:\d+)?/i.test(url) || /^\d+\.\d+\.\d+\.\d+/.test(url)) {
    return `http://${url}`;
  }
  return `https://${url}`;
}

export function isExternalAuthUrl(input: string): boolean {
  try {
    return new URL(input).hostname.toLowerCase() === "accounts.google.com";
  } catch {
    return false;
  }
}
