export interface InlineTerminalInputSnapshot {
  buffer: string;
  certain: boolean;
  phase: string;
  alternateScreen: boolean;
  revision: number;
}

export declare const INLINE_TERMINAL_INPUT_MAX_CHARS: number;

export declare class InlineTerminalInput {
  constructor();
  snapshot(): InlineTerminalInputSnapshot;
  updateLifecycle(phase: unknown, alternateScreen: unknown): InlineTerminalInputSnapshot;
  note(data: string): InlineTerminalInputSnapshot;
  reset(certain?: boolean): InlineTerminalInputSnapshot;
}
