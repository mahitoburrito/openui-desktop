import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { Codicon } from "./Codicon";
import { HighlightedMarkdown } from "./HighlightedMarkdown";
import { useStore } from "../stores/useStore";
import { extractWebUrls } from "../utils/webLinks";

interface SessionChatProps {
  sessionId: string;
  directory: string;
  statusLabel: string;
  statusColor: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  showHeader?: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  toolName?: string;
  toolSummary?: string;
  toolInput?: string;
  toolOutput?: string;
  toolStatus?: "running" | "complete" | "error";
  startup?: {
    agentName?: string;
    version?: string;
    model?: string;
    effort?: string;
    cwd?: string;
    permissionMode?: string;
    notices: string[];
  };
  timestamp?: string;
  optimistic?: boolean;
}

interface ChatResponse {
  available: boolean;
  state: "connecting" | "ready" | "unsupported" | "unavailable";
  messages: ChatMessage[];
  working?: boolean;
  startupPrompt?: {
    id: string;
    title: string;
    detail: string;
    confirmLabel: string;
    cancelLabel: string;
  } | null;
}

function isProbeResearchTool(message: ChatMessage): boolean {
  if (message.role !== "tool") return false;
  const name = `${message.toolName || ""} ${message.toolSummary || ""}`.toLowerCase();
  return /probe[-_ ]?research|probe_research/.test(name);
}

function probeResearchTarget(message: ChatMessage): { run?: string; metric?: string } {
  const content = [
    message.toolName,
    message.toolSummary,
    message.toolInput,
    message.toolOutput,
    message.text,
  ].filter(Boolean).join("\n");
  const run = content.match(/"(?:run_id|run_slug|run)"\s*:\s*"([^"]+)"/i)?.[1]
    || content.match(/\brun:([a-z0-9][a-z0-9._-]*)/i)?.[1];
  const metric = content.match(/"(?:metric_key|metric|key)"\s*:\s*"([^"]+)"/i)?.[1]
    || content.match(/\bmetric:([a-z0-9][a-z0-9._/-]*)/i)?.[1];
  return { run, metric };
}

export function SessionChat({
  sessionId,
  directory,
  statusLabel,
  statusColor,
  agentId,
  agentName,
  agentColor,
  showHeader = true,
}: SessionChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[]>([]);
  const [chatState, setChatState] = useState<ChatResponse["state"]>("connecting");
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const [transcriptWorking, setTranscriptWorking] = useState<boolean | null>(null);
  const [sendError, setSendError] = useState("");
  const [startupPrompt, setStartupPrompt] = useState<ChatResponse["startupPrompt"]>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingInputsRef = useRef<string[]>([]);
  const refreshMessagesRef = useRef<() => void>(() => {});
  const endRef = useRef<HTMLDivElement>(null);
  const linkHistoryHydratedRef = useRef(false);
  const processedAssistantMessagesRef = useRef<Set<string>>(new Set());
  const processedProbeMessagesRef = useRef<Set<string>>(new Set());
  const openBrowserUrl = useStore((state) => state.openBrowserUrl);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    const loadMessages = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Messages unavailable");
        const data = (await response.json()) as ChatResponse;
        if (disposed) return;
        const nextMessages = Array.isArray(data.messages) ? data.messages : [];

        // The first ready transcript is history, not a new reply. Mark its
        // assistant messages as seen so opening Chat never launches old links.
        if (data.state === "ready" && !linkHistoryHydratedRef.current) {
          for (const message of nextMessages) {
            if (message.role === "assistant") {
              processedAssistantMessagesRef.current.add(message.id);
            }
          }
          linkHistoryHydratedRef.current = true;
        }

        setMessages(nextMessages);
        setChatState(data.state || "connecting");
        setTranscriptWorking(typeof data.working === "boolean" ? data.working : null);
        setStartupPrompt(data.startupPrompt || null);

        const confirmedUserText = new Set(
          nextMessages
            .filter((message) => message.role === "user" && message.text)
            .map((message) => message.text!.trim()),
        );
        setOptimisticMessages((current) =>
          current.filter((message) => !confirmedUserText.has(message.text?.trim() || "")),
        );
      } catch {
        if (!disposed) setChatState("unavailable");
      } finally {
        inFlight = false;
      }
    };

    setMessages([]);
    setOptimisticMessages([]);
    setChatState("connecting");
    setTranscriptWorking(null);
    setSendError("");
    setStartupPrompt(null);
    pendingInputsRef.current = [];
    linkHistoryHydratedRef.current = false;
    processedAssistantMessagesRef.current = new Set();
    processedProbeMessagesRef.current = new Set();
    refreshMessagesRef.current = () => void loadMessages();
    void loadMessages();
    const interval = window.setInterval(loadMessages, 1400);

    return () => {
      disposed = true;
      refreshMessagesRef.current = () => {};
      window.clearInterval(interval);
    };
  }, [sessionId]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${sessionId}`);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "chat-input-error") {
          const failedText = pendingInputsRef.current.shift() || "";
          if (failedText) {
            setDraft((current) => current || failedText);
            setOptimisticMessages((current) =>
              current.filter((item) => item.text?.trim() !== failedText.trim()),
            );
          }
          setSendError(message.message || "Message was not sent");
          return;
        }
        if (message.type === "chat-input-accepted") {
          pendingInputsRef.current.shift();
          setSendError("");
        }
      } catch {
        // Terminal output is rendered by the terminal pane.
      }
      refreshMessagesRef.current();
    };

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [sessionId]);

  const visibleMessages = useMemo(
    () => [...messages, ...optimisticMessages],
    [messages, optimisticMessages],
  );
  const sessionUnavailable = ["offline", "disconnected", "error"].some((state) =>
    statusLabel.toLowerCase().includes(state),
  );
  const canSend = connected && chatState === "ready" && !sessionUnavailable && !startupPrompt;
  const hasRunningTool = visibleMessages.some(
    (message) => message.role === "tool" && message.toolStatus === "running",
  );
  const lastConversationMessage = [...visibleMessages]
    .reverse()
    .find((message) => message.role !== "system");
  const waitingForAssistant =
    lastConversationMessage?.role === "user" || lastConversationMessage?.role === "tool";
  const statusSaysWorking = statusLabel.toLowerCase() === "working";
  // Claude's status hook can stay on "working" for a moment after the final
  // answer lands. A finished assistant message is stronger evidence: once it
  // exists, hide the spinner unless the transcript itself says work continues.
  const isAgentThinking = connected && (
    hasRunningTool ||
    transcriptWorking === true ||
    (transcriptWorking === null && statusSaysWorking && waitingForAssistant)
  );

  useEffect(() => {
    if (!linkHistoryHydratedRef.current || chatState !== "ready" || isAgentThinking) return;

    const newAssistantMessages = messages.filter(
      (message) =>
        message.role === "assistant" &&
        !processedAssistantMessagesRef.current.has(message.id),
    );
    if (newAssistantMessages.length === 0) return;

    for (const message of newAssistantMessages) {
      processedAssistantMessagesRef.current.add(message.id);
    }

    const firstUrl = newAssistantMessages
      .flatMap((message) => extractWebUrls(message.text || ""))[0];
    if (firstUrl) openBrowserUrl(firstUrl, "chat-auto");
  }, [chatState, isAgentThinking, messages, openBrowserUrl]);

  useEffect(() => {
    if (!linkHistoryHydratedRef.current || chatState !== "ready") return;

    const newProbeMessages = messages.filter(
      (message) =>
        isProbeResearchTool(message) &&
        message.toolStatus === "complete" &&
        !processedProbeMessagesRef.current.has(message.id),
    );
    if (newProbeMessages.length === 0) return;

    for (const message of newProbeMessages) {
      processedProbeMessagesRef.current.add(message.id);
    }

    const latest = newProbeMessages[newProbeMessages.length - 1];
    window.dispatchEvent(new CustomEvent("openui:probe-research", {
      detail: probeResearchTarget(latest),
    }));
  }, [chatState, messages]);

  const openChatLink = useCallback(
    (url: string) => openBrowserUrl(url, "chat-click"),
    [openBrowserUrl],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [isAgentThinking, visibleMessages.length]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    const socket = socketRef.current;
    if (!text || !canSend || !socket || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({ type: "chat-input", data: text }));
    pendingInputsRef.current.push(text);
    setSendError("");
    setOptimisticMessages((current) => [
      ...current,
      {
        id: `optimistic-${Date.now()}`,
        role: "user",
        text,
        timestamp: new Date().toISOString(),
        optimistic: true,
      },
    ]);
    setDraft("");
  };

  const answerStartupPrompt = (data: "\r" | "\x1b") => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", data }));
    setStartupPrompt(null);
    setChatState("connecting");
  };

  return (
    <section className="focus-chat-surface flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-8 sm:px-8">
        <article className="mx-auto w-full max-w-[820px]" aria-label={`${agentName} conversation`}>
          {showHeader && (
            <header className="mb-8 flex items-center gap-3 border-b border-white/[0.055] pb-5">
              <span className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-white/[0.07] bg-white/[0.035]">
                <AgentIcon
                  agentId={agentId}
                  iconId={agentId}
                  className="h-[22px] w-[22px]"
                  style={{ color: agentColor }}
                />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-[14px] font-semibold tracking-[-0.01em] text-zinc-100">
                  {agentName}
                </strong>
                <span
                  className="mt-0.5 flex items-center gap-1.5 text-[10.5px]"
                  style={{ color: connected ? statusColor : "oklch(57% 0.01 255)" }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: connected ? statusColor : "oklch(57% 0.01 255)" }}
                  />
                  {connected ? statusLabel : "Connecting"}
                </span>
              </span>
            </header>
          )}

          {visibleMessages.length > 0 || isAgentThinking || startupPrompt ? (
            <div className="space-y-7" role="log" aria-live="polite">
              {startupPrompt && (
                <StartupPromptCard
                  prompt={startupPrompt}
                  onConfirm={() => answerStartupPrompt("\r")}
                  onCancel={() => answerStartupPrompt("\x1b")}
                />
              )}
              {visibleMessages.map((message) => (
                <ConversationMessage
                  key={message.id}
                  message={message}
                  agentId={agentId}
                  agentColor={agentColor}
                  onOpenLink={openChatLink}
                />
              ))}
              {isAgentThinking && (
                <ThinkingIndicator
                  agentId={agentId}
                  agentColor={agentColor}
                  label={hasRunningTool ? "Working…" : "Thinking…"}
                />
              )}
            </div>
          ) : (
            <EmptyConversation agentName={agentName} agentId={agentId} agentColor={agentColor} state={chatState} />
          )}
          <div ref={endRef} />
        </article>
      </div>

      <form
        onSubmit={send}
        className="flex-shrink-0 border-t border-white/[0.045] bg-[var(--focus-charcoal)] px-4 pb-4 pt-4 sm:px-7"
      >
        <div className="mx-auto w-full max-w-[720px] rounded-[10px] border border-white/[0.085] bg-[var(--focus-charcoal-raised)] p-2 shadow-[0_12px_34px_oklch(0.03_0.005_255/.2)] transition-[border-color,box-shadow] duration-150 focus-within:border-white/[0.16] focus-within:shadow-[0_14px_38px_oklch(0.03_0.005_255/.26)]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!canSend}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            placeholder={canSend ? `Message ${agentName}…` : `Starting ${agentName}…`}
            className="max-h-32 min-h-12 w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-5 text-zinc-200 placeholder-zinc-600 focus:outline-none disabled:cursor-wait disabled:opacity-60"
          />
          <div className="mt-1 flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2 text-[10px] text-zinc-600">
              <button
                type="button"
                className="workspace-icon-button flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[6px] text-zinc-500 hover:text-zinc-200"
                aria-label="Add context"
                title="Add context"
              >
                <Codicon name="add" size={15} />
              </button>
              <span className={sendError ? "truncate text-red-400" : "truncate"} title={sendError || directory}>
                {sendError || directory}
              </span>
            </div>
            <button
              type="submit"
              disabled={!draft.trim() || !canSend}
              className="workspace-icon-button flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[6px] bg-zinc-200 text-canvas-dark hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
              aria-label="Send message"
            >
              <Codicon name="arrow-up" size={13} />
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function StartupPromptCard({
  prompt,
  onConfirm,
  onCancel,
}: {
  prompt: NonNullable<ChatResponse["startupPrompt"]>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="rounded-[10px] border border-[#D97757]/25 bg-[#D97757]/[0.055] p-4" aria-label={prompt.title}>
      <div className="flex items-start gap-3">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] bg-[#D97757]/10 text-[#D97757]">
          <Codicon name="warning" size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[13px] font-medium text-zinc-200">{prompt.title}</strong>
          <p className="mt-1 text-[11.5px] leading-5 text-zinc-500">{prompt.detail}</p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-[7px] bg-zinc-100 px-3 py-1.5 text-[11px] font-medium text-zinc-900 hover:bg-white"
            >
              {prompt.confirmLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="workspace-icon-button rounded-[7px] px-3 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
            >
              {prompt.cancelLabel}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ThinkingIndicator({
  agentId,
  agentColor,
  label,
}: {
  agentId: string;
  agentColor: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3" role="status" aria-label={label}>
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] border border-white/[0.065] bg-white/[0.03]">
        <AgentIcon
          agentId={agentId}
          iconId={agentId}
          className="h-[17px] w-[17px]"
          style={{ color: agentColor }}
        />
      </span>
      <span className="flex items-center gap-2 text-[12px] text-zinc-500">
        <Codicon
          name="loading"
          size={13}
          className="codicon-modifier-spin text-[#D97757]"
        />
        <span>{label}</span>
      </span>
    </div>
  );
}

function ConversationMessage({
  message,
  agentId,
  agentColor,
  onOpenLink,
}: {
  message: ChatMessage;
  agentId: string;
  agentColor: string;
  onOpenLink: (url: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[min(78%,64ch)] rounded-[12px] border border-white/[0.075] bg-white/[0.055] px-4 py-3 text-[13.5px] leading-6 text-zinc-200 shadow-sm">
          <p className="m-0 whitespace-pre-wrap break-words">{message.text}</p>
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return <ToolCallMessage message={message} />;
  }

  if (message.role === "system" && message.startup) {
    return <SessionStartupMessage startup={message.startup} />;
  }

  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] border border-white/[0.065] bg-white/[0.03]">
        <AgentIcon agentId={agentId} iconId={agentId} className="h-[17px] w-[17px]" style={{ color: agentColor }} />
      </span>
      <MessageMarkdown text={message.text || ""} onOpenLink={onOpenLink} />
    </div>
  );
}

function ToolCallMessage({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const statusIcon = message.toolStatus === "error" ? "error" : message.toolStatus === "running" ? "loading" : "check";
  const statusLabel = message.toolStatus === "error" ? "Failed" : message.toolStatus === "running" ? "Running" : "Done";
  const hasDetails = Boolean(message.toolInput || message.toolOutput);

  return (
    <div className="ml-10 max-w-[72ch] border-y border-white/[0.045] text-[11px] text-zinc-500">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((open) => !open)}
        className={`flex w-full items-center gap-2.5 py-2 text-left ${hasDetails ? "cursor-pointer hover:text-zinc-300" : "cursor-default"}`}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <Codicon name={toolIcon(message.toolName)} size={14} className="text-zinc-500" />
        <strong className="font-medium text-zinc-400">{message.toolName || "Tool"}</strong>
        {message.toolSummary && <span className="min-w-0 flex-1 truncate text-zinc-600">{message.toolSummary}</span>}
        <span className={`ml-auto flex flex-shrink-0 items-center gap-1 ${message.toolStatus === "error" ? "text-red-400" : "text-zinc-600"}`}>
          <Codicon name={statusIcon} size={12} className={message.toolStatus === "running" ? "codicon-modifier-spin" : ""} />
          {statusLabel}
        </span>
        {hasDetails && (
          <Codicon name={expanded ? "chevron-up" : "chevron-down"} size={12} className="flex-shrink-0 text-zinc-600" />
        )}
      </button>
      {expanded && (
        <div className="mb-2 overflow-hidden rounded-[8px] border border-white/[0.055] bg-[oklch(0.095_0.004_255)]">
          {message.toolInput && <ToolDetail label="Input" value={message.toolInput} />}
          {message.toolOutput && <ToolDetail label="Output" value={message.toolOutput} bordered={Boolean(message.toolInput)} />}
        </div>
      )}
    </div>
  );
}

function ToolDetail({ label, value, bordered = false }: { label: string; value: string; bordered?: boolean }) {
  return (
    <div className={bordered ? "border-t border-white/[0.055]" : ""}>
      <div className="px-3 pb-1 pt-2 text-[9px] font-medium uppercase tracking-[0.1em] text-zinc-600">{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[10.5px] leading-5 text-zinc-400">{value}</pre>
    </div>
  );
}

function SessionStartupMessage({ startup }: { startup: NonNullable<ChatMessage["startup"]> }) {
  const model = startup.model ? friendlyClaudeValue(startup.model) : null;
  const effort = startup.effort ? `${friendlyClaudeValue(startup.effort)} effort` : null;
  const permission = startup.permissionMode === "bypassPermissions"
    ? "Bypass permissions"
    : startup.permissionMode
      ? friendlyClaudeValue(startup.permissionMode)
      : null;

  return (
    <section className="rounded-[10px] border border-white/[0.055] bg-white/[0.018] px-4 py-3" aria-label="Session startup">
      <div className="flex items-center gap-2 text-[11px] text-zinc-400">
        <Codicon name="debug-start" size={13} className="text-zinc-500" />
        <strong className="font-medium text-zinc-300">
          {startup.agentName || "Claude Code"}{startup.version ? ` ${startup.version}` : ""}
        </strong>
        <span className="text-zinc-700">ready</span>
      </div>
      {(model || effort || permission || startup.cwd) && (
        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-zinc-600">
          {model && <span>{model}</span>}
          {effort && <span>· {effort}</span>}
          {permission && <span>· {permission}</span>}
          {startup.cwd && <span className="w-full truncate font-mono" title={startup.cwd}>{startup.cwd}</span>}
        </div>
      )}
      {startup.notices.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-white/[0.045] pt-2.5">
          {startup.notices.map((notice) => (
            <p key={notice} className="m-0 text-[10.5px] leading-4 text-zinc-600">{notice}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function friendlyClaudeValue(value: string) {
  return value
    .replace(/^claude-/i, "Claude ")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function MessageMarkdown({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }) {
  return (
    <HighlightedMarkdown
      text={text}
      onOpenLink={onOpenLink}
      className="chat-message-markdown min-w-0 max-w-[72ch] flex-1"
    />
  );
}

function EmptyConversation({
  agentName,
  agentId,
  agentColor,
  state,
}: {
  agentName: string;
  agentId: string;
  agentColor: string;
  state: ChatResponse["state"];
}) {
  const copy = state === "ready"
    ? `Start a conversation with ${agentName}.`
    : "Conversation is connecting. Terminal is still available.";

  return (
    <div className="flex min-h-[42vh] items-center justify-center">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] border border-white/[0.07] bg-white/[0.035]">
          <AgentIcon agentId={agentId} iconId={agentId} className="h-[22px] w-[22px]" style={{ color: agentColor }} />
        </span>
        <p className="mt-4 text-[12px] text-zinc-500">{copy}</p>
      </div>
    </div>
  );
}

function toolIcon(name: string | undefined) {
  const normalized = name?.toLowerCase() || "";
  if (normalized === "bash") return "terminal";
  if (normalized.includes("read")) return "file-code";
  if (normalized.includes("edit")) return "edit";
  if (normalized.includes("write")) return "new-file";
  if (normalized.includes("grep") || normalized.includes("search")) return "search";
  if (normalized.includes("web")) return "globe";
  if (normalized.includes("task")) return "server-process";
  return "tools";
}
