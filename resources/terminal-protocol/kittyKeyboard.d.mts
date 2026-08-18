export const KITTY_KEYBOARD_SUPPORTED_FLAGS: number;
export const KITTY_KEYBOARD_STACK_MAX_DEPTH: number;

export interface KittyKeyboardEvent {
  type?: string;
  key?: string;
  code?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export function encodeKittyKeyboardEvent(
  event?: KittyKeyboardEvent,
  rawFlags?: number,
  isMac?: boolean,
): string | null;

export class KittyKeyboardProtocol {
  constructor(enabled?: boolean);
  enabled: boolean;
  primaryModeStack: number[];
  alternateModeStack: number[];
  alternateScreen: boolean;
  state: string;
  pending: string;
  controlStringAllowsBel: boolean;
  readonly flags: number;
  readonly stackDepth: number;
  processOutput(data?: string, sendResponse?: (response: string) => void): string;
  reset(): void;
  activeModeStack(): number[];
  setActiveFlags(flags?: number): void;
  pushFlags(flags?: number): void;
  popFlags(count?: number): void;
  consumeKittySequence(
    sequence?: string,
    sendResponse?: (response: string) => void,
  ): boolean;
  observeAlternateScreen(sequence?: string): void;
}
