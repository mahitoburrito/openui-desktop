import { create } from "zustand";
import type {
  PRBESerializedState,
  PRBEStatusEvent,
  InteractionPayload,
  InteractionResponse,
  PRBESerializedCompletedInvestigation,
  ConversationEntry,
  ResolvedInteraction,
} from "../types/prbe";

interface PRBEStore {
  // Availability
  isAvailable: boolean;
  isInitialized: boolean;
  hasApiKey: boolean;

  // Investigation state
  isInvestigating: boolean;
  currentQuery: string;
  events: PRBEStatusEvent[];
  report: string;
  summary: string;
  investigationError?: string;
  agentMessage?: string;
  conversationHistory: ConversationEntry[];
  resolvedInteractions: ResolvedInteraction[];
  completedInvestigations: PRBESerializedCompletedInvestigation[];

  // Interaction
  pendingInteraction: InteractionPayload | null;

  // UI
  panelOpen: boolean;

  // Actions
  setPanelOpen: (open: boolean) => void;
  checkAvailability: () => Promise<void>;
  initialize: () => Promise<void>;
  startInvestigation: (query: string) => Promise<void>;
  stopInvestigation: () => Promise<void>;
  respondToInteraction: (interactionId: string, response: InteractionResponse) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;

  // Internal — called by IPC listeners
  _onStateUpdate: (state: PRBESerializedState) => void;
  _onInteractionRequest: (payload: InteractionPayload) => void;
  _onComplete: (data: { report: string; summary?: string }) => void;
  _onError: (data: { message: string }) => void;
}

export const usePRBEStore = create<PRBEStore>((set) => ({
  // Defaults
  isAvailable: false,
  isInitialized: false,
  hasApiKey: false,
  isInvestigating: false,
  currentQuery: "",
  events: [],
  report: "",
  summary: "",
  conversationHistory: [],
  resolvedInteractions: [],
  completedInvestigations: [],
  pendingInteraction: null,
  panelOpen: false,

  setPanelOpen: (open) => set({ panelOpen: open }),

  checkAvailability: async () => {
    const isElectron = !!window.electronAPI?.isElectron;
    if (!isElectron) {
      set({ isAvailable: false });
      return;
    }

    try {
      const result = await window.electronAPI!.invoke("prbe:is-available");
      set({
        isAvailable: true,
        hasApiKey: result.hasApiKey,
        isInitialized: result.isInitialized,
      });
    } catch {
      set({ isAvailable: true, hasApiKey: false, isInitialized: false });
    }
  },

  initialize: async () => {
    if (!window.electronAPI?.isElectron) return;
    try {
      const result = await window.electronAPI.invoke("prbe:initialize");
      if (result.success) {
        set({ isInitialized: true, hasApiKey: true });
      }
    } catch (e) {
      console.error("[prbe] Failed to initialize:", e);
    }
  },

  startInvestigation: async (query) => {
    if (!window.electronAPI?.isElectron) return;
    set({
      isInvestigating: true,
      currentQuery: query,
      events: [],
      report: "",
      summary: "",
      investigationError: undefined,
      agentMessage: undefined,
      pendingInteraction: null,
      resolvedInteractions: [],
      conversationHistory: [],
    });
    try {
      await window.electronAPI.invoke("prbe:start-investigation", { query });
    } catch (e) {
      console.error("[prbe] Failed to start investigation:", e);
      set({ isInvestigating: false, investigationError: "Failed to start investigation" });
    }
  },

  stopInvestigation: async () => {
    if (!window.electronAPI?.isElectron) return;
    try {
      await window.electronAPI.invoke("prbe:stop-investigation");
      set({ isInvestigating: false });
    } catch (e) {
      console.error("[prbe] Failed to stop investigation:", e);
    }
  },

  respondToInteraction: async (interactionId, response) => {
    if (!window.electronAPI?.isElectron) return;
    try {
      await window.electronAPI.invoke("prbe:respond-interaction", { interactionId, response });
      set({ pendingInteraction: null });
    } catch (e) {
      console.error("[prbe] Failed to respond to interaction:", e);
    }
  },

  sendMessage: async (message) => {
    if (!window.electronAPI?.isElectron) return;
    try {
      await window.electronAPI.invoke("prbe:send-message", { message });
    } catch (e) {
      console.error("[prbe] Failed to send message:", e);
    }
  },

  // Internal state update from IPC
  _onStateUpdate: (state) => {
    set({
      isInvestigating: state.isInvestigating,
      events: state.events,
      report: state.report,
      summary: state.summary || "",
      currentQuery: state.currentQuery,
      investigationError: state.investigationError,
      agentMessage: state.agentMessage,
      conversationHistory: state.conversationHistory,
      resolvedInteractions: state.resolvedInteractions,
      completedInvestigations: state.completedInvestigations,
      pendingInteraction: state.pendingInteraction || null,
    });
  },

  _onInteractionRequest: (payload) => {
    set({ pendingInteraction: payload });
  },

  _onComplete: (data) => {
    set({
      isInvestigating: false,
      report: data.report,
      summary: data.summary || "",
    });
  },

  _onError: (data) => {
    set({
      isInvestigating: false,
      investigationError: data.message,
    });
  },
}));
