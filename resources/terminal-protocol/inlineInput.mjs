export const INLINE_TERMINAL_INPUT_MAX_CHARS = 4096;

function boundedAppend(value, addition) {
  if (!addition || value.length >= INLINE_TERMINAL_INPUT_MAX_CHARS) return value;
  return `${value}${addition}`.slice(0, INLINE_TERMINAL_INPUT_MAX_CHARS);
}

export class InlineTerminalInput {
  constructor() {
    this.buffer = "";
    this.certain = true;
    this.phase = "unknown";
    this.alternateScreen = false;
    this.revision = 0;
    this.controlCarry = "";
    this.bracketedPaste = false;
  }

  snapshot() {
    return {
      buffer: this.buffer,
      certain: this.certain,
      phase: this.phase,
      alternateScreen: this.alternateScreen,
      revision: this.revision,
    };
  }

  updateLifecycle(phaseValue, alternateScreenValue) {
    const phase = typeof phaseValue === "string" ? phaseValue : "unknown";
    const alternateScreen = Boolean(alternateScreenValue);
    const reachedFreshPrompt = phase === "at_prompt" &&
      (this.phase !== "at_prompt" || (this.alternateScreen && !alternateScreen));
    const changed = phase !== this.phase || alternateScreen !== this.alternateScreen || reachedFreshPrompt ||
      ((phase !== "at_prompt" || alternateScreen) && (this.buffer || !this.certain));
    this.phase = phase;
    this.alternateScreen = alternateScreen;
    if (reachedFreshPrompt) this.resetInternal(true);
    if (phase !== "at_prompt" || alternateScreen) this.resetInternal(phase === "at_prompt");
    if (changed) this.revision += 1;
    return this.snapshot();
  }

  note(data) {
    if (this.phase !== "at_prompt" || this.alternateScreen || typeof data !== "string" || !data) {
      return this.snapshot();
    }
    const input = this.controlCarry + data;
    this.controlCarry = "";
    let changed = false;

    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (char === "\x1b") {
        if (index + 1 >= input.length) {
          this.controlCarry = input.slice(index);
          break;
        }
        if (input[index + 1] === "[") {
          let end = index + 2;
          while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end++;
          if (end >= input.length) {
            this.controlCarry = input.slice(index);
            break;
          }
          const sequence = input.slice(index, end + 1);
          if (sequence === "\x1b[200~") this.bracketedPaste = true;
          else if (sequence === "\x1b[201~") this.bracketedPaste = false;
          else this.certain = false;
          changed = true;
          index = end;
          continue;
        }
        this.certain = false;
        changed = true;
        break;
      }

      if (char === "\r" || char === "\n") {
        if (this.bracketedPaste) {
          this.buffer = boundedAppend(this.buffer, "\n");
          this.certain = false;
        } else {
          this.resetInternal(true);
        }
        changed = true;
        continue;
      }
      if (char === "\x7f" || char === "\b") {
        this.buffer = Array.from(this.buffer).slice(0, -1).join("");
        changed = true;
        continue;
      }
      if (char === "\x15" || char === "\x03") {
        this.resetInternal(true);
        changed = true;
        continue;
      }
      if (char === "\x17") {
        this.buffer = this.buffer.replace(/\s*\S+\s*$/, "");
        changed = true;
        continue;
      }
      if (char === "\x0c") continue;
      if (char === "\t" || (char < " " && char !== "\x00")) {
        if (this.bracketedPaste) this.buffer = boundedAppend(this.buffer, char);
        this.certain = false;
        changed = true;
        continue;
      }
      if (char >= " " && char !== "\x7f") {
        this.buffer = boundedAppend(this.buffer, char);
        changed = true;
      }
    }

    if (changed) this.revision += 1;
    return this.snapshot();
  }

  reset(certain = true) {
    const changed = Boolean(this.buffer) || this.certain !== certain || Boolean(this.controlCarry) || this.bracketedPaste;
    this.resetInternal(certain);
    if (changed) this.revision += 1;
    return this.snapshot();
  }

  resetInternal(certain) {
    this.buffer = "";
    this.certain = certain;
    this.controlCarry = "";
    this.bracketedPaste = false;
  }
}
