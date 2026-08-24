export const SESSION_TITLE_MAX_CHARS = 120;

export interface SessionTitleFields {
  agentName?: string;
  customName?: string | null;
  generatedTitle?: string | null;
  ticketTitle?: string | null;
  sessionOrdinal?: number;
  sessionGroupSize?: number;
}

export function normalizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, SESSION_TITLE_MAX_CHARS).join("").trim() || undefined;
}

export function migrateLegacySessionTitles(customName: unknown, generatedTitle: unknown): {
  customName?: string;
  generatedTitle?: string;
} {
  const custom = normalizeSessionTitle(customName);
  const generated = normalizeSessionTitle(generatedTitle);
  return {
    customName: generated && custom === generated ? undefined : custom,
    generatedTitle: generated,
  };
}

export function baseSessionTitle(session: SessionTitleFields, fallback = "Session"): string {
  return (
    sessionTaskTitle(session) ||
    normalizeSessionTitle(session.agentName) ||
    fallback
  );
}

export function sessionTaskTitle(session: SessionTitleFields): string | undefined {
  return normalizeSessionTitle(session.customName) ||
    normalizeSessionTitle(session.generatedTitle) ||
    normalizeSessionTitle(session.ticketTitle);
}

export function sessionTitleDisambiguator(session: SessionTitleFields): string | undefined {
  const ordinal = session.sessionOrdinal;
  const groupSize = session.sessionGroupSize;
  if (
    !Number.isSafeInteger(ordinal) || !Number.isSafeInteger(groupSize) ||
    Number(ordinal) < 1 || Number(groupSize) < 2 || Number(ordinal) > Number(groupSize)
  ) return undefined;
  return `#${ordinal}`;
}

export function sessionDisplayTitle(session: SessionTitleFields, fallback = "Session"): string {
  const title = baseSessionTitle(session, fallback);
  const disambiguator = sessionTitleDisambiguator(session);
  if (!disambiguator) return title;
  const suffix = ` · ${disambiguator}`;
  const availableTitleChars = SESSION_TITLE_MAX_CHARS - Array.from(suffix).length;
  const boundedTitle = Array.from(title).slice(0, availableTitleChars).join("").trimEnd();
  return `${boundedTitle}${suffix}`;
}
