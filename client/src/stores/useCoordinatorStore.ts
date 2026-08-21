import { create } from "zustand";
import type { CoordinatorMode, CoordinatorSnapshot } from "../types/coordinator";

interface CoordinatorStore {
  snapshot: CoordinatorSnapshot | null;
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  setMode: (mode: CoordinatorMode) => Promise<void>;
  acknowledgeDirective: (directiveId: string) => Promise<void>;
  cancelDirective: (directiveId: string) => Promise<void>;
}

async function coordinatorFetch(path: string, init?: RequestInit) {
  const response = await fetch(`/api/coordinator${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export const useCoordinatorStore = create<CoordinatorStore>((set, get) => ({
  snapshot: null,
  loading: false,

  refresh: async () => {
    if (!get().snapshot) set({ loading: true });
    try {
      const snapshot = await coordinatorFetch("/snapshot");
      set({ snapshot, loading: false, error: undefined });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Coordinator unavailable" });
    }
  },

  setMode: async (mode) => {
    try {
      await coordinatorFetch("/mode", {
        method: "PUT",
        body: JSON.stringify({ mode, author: "user" }),
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Could not change coordinator mode" });
    }
  },

  acknowledgeDirective: async (directiveId) => {
    try {
      await coordinatorFetch(`/directives/${encodeURIComponent(directiveId)}/acknowledge`, {
        method: "POST",
        body: "{}",
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Could not acknowledge directive" });
    }
  },

  cancelDirective: async (directiveId) => {
    try {
      await coordinatorFetch(`/directives/${encodeURIComponent(directiveId)}/cancel`, {
        method: "POST",
        body: "{}",
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Could not cancel directive" });
    }
  },
}));
