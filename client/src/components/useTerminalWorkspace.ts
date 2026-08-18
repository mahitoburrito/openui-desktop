import { useCallback, useEffect, useRef, useState } from "react";

export type TerminalWorkspacePaneNode =
  | { id: string; type: "pane"; sessionId: string }
  | {
      id: string;
      type: "split";
      direction: "horizontal" | "vertical";
      sizes: number[];
      children: TerminalWorkspacePaneNode[];
    };

export interface TerminalWorkspaceTab {
  id: string;
  title?: string;
  root: TerminalWorkspacePaneNode;
  activeSessionId: string;
  zoomedSessionId?: string;
}

export interface TerminalWorkspaceSnapshot {
  version: 1;
  revision: number;
  tabs: TerminalWorkspaceTab[];
  activeTabId?: string;
  detachedSessionIds: string[];
  closedPaneCount: number;
  updatedAt: number;
}

export type TerminalPaneLayout =
  | { type: "pane"; sessionRef: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      sizes?: number[];
      children: TerminalPaneLayout[];
    };

export interface TerminalLaunchConfiguration {
  id: string;
  version: 1;
  name: string;
  description: string;
  sessions: TerminalLaunchSession[];
  layout?: TerminalPaneLayout;
  activeSessionRef?: string;
  launchMode: "atomic" | "best-effort";
  createdAt: number;
  updatedAt: number;
}

export interface TerminalLaunchSession {
  ref: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  customName?: string;
  customColor?: string;
  initialPrompt?: string;
  workflowId?: string;
  workflowValues?: Record<string, string>;
  position?: { x: number; y: number };
}

interface MutationResponse {
  workspace?: TerminalWorkspaceSnapshot;
  error?: string;
  [key: string]: unknown;
}

export function collectWorkspaceSessionIds(node: TerminalWorkspacePaneNode, output: string[] = []): string[] {
  if (node.type === "pane") output.push(node.sessionId);
  else node.children.forEach((child) => collectWorkspaceSessionIds(child, output));
  return output;
}

export function mapWorkspaceLayout(
  node: TerminalWorkspacePaneNode,
  refs: Map<string, string>,
): TerminalPaneLayout {
  if (node.type === "pane") return { type: "pane", sessionRef: refs.get(node.sessionId)! };
  return {
    type: "split",
    direction: node.direction,
    sizes: node.sizes,
    children: node.children.map((child) => mapWorkspaceLayout(child, refs)),
  };
}

export function useTerminalWorkspace(enabled: boolean) {
  const [workspace, setWorkspace] = useState<TerminalWorkspaceSnapshot | null>(null);
  const [launchConfigurations, setLaunchConfigurations] = useState<TerminalLaunchConfiguration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revisionRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    revisionRef.current = workspace?.revision;
  }, [workspace?.revision]);

  const refresh = useCallback(async () => {
    if (!enabled) return null;
    try {
      const response = await fetch("/api/terminal/workspace", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Terminal workspace could not be loaded");
      setWorkspace(body.workspace);
      setError(null);
      return body.workspace as TerminalWorkspaceSnapshot;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Terminal workspace could not be loaded");
      return null;
    }
  }, [enabled]);

  const refreshLaunchConfigurations = useCallback(async () => {
    if (!enabled) return [];
    try {
      const response = await fetch("/api/terminal/launch-configurations", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Launch configurations could not be loaded");
      const next = (body.launchConfigurations || []) as TerminalLaunchConfiguration[];
      setLaunchConfigurations(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch configurations could not be loaded");
      return [];
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    void refreshLaunchConfigurations();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, refresh, refreshLaunchConfigurations]);

  const mutate = useCallback(async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    input: Record<string, unknown> = {},
  ): Promise<MutationResponse> => {
    setBusy(true);
    try {
      const response = await fetch(`/api/terminal/workspace${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, expectedRevision: revisionRef.current }),
      });
      const body = await response.json().catch(() => ({})) as MutationResponse;
      if (!response.ok) {
        if (response.status === 409) void refresh();
        throw new Error(body.error || "Terminal workspace could not be updated");
      }
      if (body.workspace) setWorkspace(body.workspace);
      setError(null);
      return body;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Terminal workspace could not be updated";
      setError(message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const createLaunchConfiguration = useCallback(async (input: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch("/api/terminal/launch-configurations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Launch configuration could not be saved");
      await refreshLaunchConfigurations();
      setError(null);
      return body.launchConfiguration as TerminalLaunchConfiguration;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch configuration could not be saved");
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [refreshLaunchConfigurations]);

  const updateLaunchConfiguration = useCallback(async (id: string, input: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/terminal/launch-configurations/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Launch configuration could not be updated");
      await refreshLaunchConfigurations();
      setError(null);
      return body.launchConfiguration as TerminalLaunchConfiguration;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch configuration could not be updated");
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [refreshLaunchConfigurations]);

  const importLaunchConfigurations = useCallback(async (input: {
    yaml: string;
    defaultCwd: string;
    conflict: "skip" | "rename" | "error";
  }) => {
    setBusy(true);
    try {
      const response = await fetch("/api/terminal/launch-configurations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Launch configuration YAML could not be imported");
      await refreshLaunchConfigurations();
      setError(null);
      return {
        imported: (body.imported || []) as TerminalLaunchConfiguration[],
        skipped: (body.skipped || []) as string[],
        warnings: (body.warnings || []) as string[],
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch configuration YAML could not be imported");
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [refreshLaunchConfigurations]);

  const launchConfiguration = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/terminal/launch-configurations/${encodeURIComponent(id)}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Launch configuration could not be started");
      if (body.workspace) setWorkspace(body.workspace);
      setError(null);
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch configuration could not be started");
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  const deleteLaunchConfiguration = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/terminal/launch-configurations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Launch configuration could not be deleted");
      await refreshLaunchConfigurations();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch configuration could not be deleted");
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [refreshLaunchConfigurations]);

  return {
    workspace,
    launchConfigurations,
    error,
    busy,
    refresh,
    refreshLaunchConfigurations,
    activateTab: (tabId: string) => mutate(`/tabs/${encodeURIComponent(tabId)}/activate`, "POST"),
    renameTab: (tabId: string, title: string) => mutate(`/tabs/${encodeURIComponent(tabId)}`, "PATCH", { title }),
    closeTab: (tabId: string) => mutate(`/tabs/${encodeURIComponent(tabId)}`, "DELETE"),
    addTab: (sessionId: string, title?: string) => mutate("/tabs", "POST", { sessionId, title }),
    focusPane: (sessionId: string, direction?: "left" | "right" | "up" | "down") =>
      mutate(`/panes/${encodeURIComponent(sessionId)}/focus`, "POST", direction ? { direction } : {}),
    splitPane: (sessionId: string, direction: "right" | "down") =>
      mutate(`/panes/${encodeURIComponent(sessionId)}/split`, "POST", { direction }),
    zoomPane: (sessionId: string) => mutate(`/panes/${encodeURIComponent(sessionId)}/zoom`, "POST"),
    closePane: (sessionId: string) => mutate(`/panes/${encodeURIComponent(sessionId)}`, "DELETE"),
    resizeSplit: (splitId: string, sizes: number[]) => mutate(`/splits/${encodeURIComponent(splitId)}`, "PATCH", { sizes }),
    undoClose: () => mutate("/undo-close", "POST"),
    createLaunchConfiguration,
    updateLaunchConfiguration,
    importLaunchConfigurations,
    launchConfiguration,
    deleteLaunchConfiguration,
  };
}
