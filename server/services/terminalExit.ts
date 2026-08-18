import type { TerminalBlockFailureKind, TerminalBlockStatus } from "../types";

const WINDOWS_CONTROL_C_EXIT = -1_073_741_510;
const WINDOWS_CONTROL_C_EXIT_UNSIGNED = 3_221_225_786;

export function classifyTerminalExitCode(exitCode: number | undefined): TerminalBlockStatus {
  if (exitCode === undefined) return "unknown";
  if (exitCode === 0 || exitCode === 141) return "succeeded";
  if (
    exitCode === 130 ||
    exitCode === WINDOWS_CONTROL_C_EXIT ||
    exitCode === WINDOWS_CONTROL_C_EXIT_UNSIGNED
  ) {
    return "interrupted";
  }
  return "failed";
}

export function classifyTerminalFailureKind(
  exitCode: number | undefined,
  status: TerminalBlockStatus = classifyTerminalExitCode(exitCode),
): TerminalBlockFailureKind | undefined {
  if (status !== "failed") return undefined;
  if (exitCode === 127 || exitCode === 9009) return "command_not_found";
  if (exitCode === 126) return "not_executable";
  return "exit_error";
}
