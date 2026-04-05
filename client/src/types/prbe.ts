/**
 * Renderer-safe PRBE types — no Node.js imports.
 * These mirror the SDK's serialized types for use in the React UI.
 */

// Status event shown in the investigation feed
export interface PRBEStatusEvent {
  id: string;
  label: string;
  detail?: string;
  isCompleted: boolean;
  isExpanded: boolean;
}

// Interaction types
export enum InteractionType {
  ASK_QUESTION = "ask_question",
  REQUEST_PERMISSION = "request_permission",
  REQUEST_PATH_ACCESS = "request_path_access",
  REVIEW_SANITIZED_OUTPUT = "review_sanitized_output",
}

export interface AskQuestionPayload {
  type: InteractionType.ASK_QUESTION;
  interactionId: string;
  question: string;
  context?: string;
}

export interface RequestPermissionPayload {
  type: InteractionType.REQUEST_PERMISSION;
  interactionId: string;
  action: string;
  command: string;
  reason?: string;
}

export interface RequestPathAccessPayload {
  type: InteractionType.REQUEST_PATH_ACCESS;
  interactionId: string;
  path: string;
  reason: string;
}

export interface ReviewSanitizedOutputPayload {
  type: InteractionType.REVIEW_SANITIZED_OUTPUT;
  interactionId: string;
  sanitizedAnalysis: string;
  confidence: number;
  issues: { field: string; original: string; sanitized: string }[];
}

export type InteractionPayload =
  | AskQuestionPayload
  | RequestPermissionPayload
  | RequestPathAccessPayload
  | ReviewSanitizedOutputPayload;

export interface AskQuestionResponse {
  type: InteractionType.ASK_QUESTION;
  answer: string;
}

export interface RequestPermissionResponse {
  type: InteractionType.REQUEST_PERMISSION;
  approved: boolean;
}

export interface RequestPathAccessResponse {
  type: InteractionType.REQUEST_PATH_ACCESS;
  granted: boolean;
}

export interface ReviewSanitizedOutputResponse {
  type: InteractionType.REVIEW_SANITIZED_OUTPUT;
  approved: boolean;
  editedText?: string;
}

export type InteractionResponse =
  | AskQuestionResponse
  | RequestPermissionResponse
  | RequestPathAccessResponse
  | ReviewSanitizedOutputResponse;

// Resolved interaction (question + response pair)
export interface ResolvedInteraction {
  interactionId: string;
  payload: InteractionPayload;
  response: InteractionResponse;
  eventIndex: number;
}

// Conversation entry
export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

// Completed investigation
export interface PRBESerializedCompletedInvestigation {
  id: string;
  query: string;
  report: string;
  summary?: string;
  ticketId?: string;
  events: PRBEStatusEvent[];
  resolvedInteractions: ResolvedInteraction[];
  conversationHistory?: ConversationEntry[];
  completedAt: string;
}

// Full serialized state from main process
export interface PRBESerializedState {
  isInvestigating: boolean;
  events: PRBEStatusEvent[];
  report: string;
  summary?: string;
  currentQuery: string;
  investigationError?: string;
  pendingInteraction?: InteractionPayload;
  resolvedInteractions: ResolvedInteraction[];
  agentMessage?: string;
  conversationHistory: ConversationEntry[];
  completedInvestigations: PRBESerializedCompletedInvestigation[];
  hasActiveWork: boolean;
}

// ElectronAPI type augmentation
declare global {
  interface Window {
    electronAPI?: {
      platform: string;
      isElectron: boolean;
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on: (channel: string, callback: (...args: any[]) => void) => void;
      removeAllListeners: (channel: string) => void;
    };
  }
}
