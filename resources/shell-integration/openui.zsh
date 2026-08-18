# OpenUI semantic shell integration.
# Uses the public OSC 633 shell-integration protocol understood by OpenUI's
# terminal lifecycle parser. The guard keeps repeated sourcing idempotent.
if [[ -n "${OPENUI_SHELL_SHIM_DIR:-}" && -d "$OPENUI_SHELL_SHIM_DIR" ]]; then
  case "$PATH" in
    "$OPENUI_SHELL_SHIM_DIR"|"$OPENUI_SHELL_SHIM_DIR":*) ;;
    *) export PATH="$OPENUI_SHELL_SHIM_DIR:$PATH" ;;
  esac
  # User startup files may have moved system directories ahead of the
  # process-private shims. Refresh zsh's command table after restoring order.
  rehash
fi

if [[ -n "${OPENUI_SHELL_INTEGRATION_LOADED:-}" ]]; then
  printf '\e]633;I;zsh;%s\a' "$__OPENUI_EPOCH_ID"
  return 0
fi

typeset -g OPENUI_SHELL_INTEGRATION_LOADED=1
typeset -g __OPENUI_EPOCH_ID="zsh-$$-$RANDOM"
typeset -g __OPENUI_COMMAND_RUNNING=0
typeset -g __OPENUI_READY=0
typeset -gA __OPENUI_COMPLETION_PAYLOADS=()
typeset -gA __OPENUI_SHELL_ENVIRONMENT_PAYLOADS=()
typeset -g __OPENUI_CAPABILITY_AUTOCD_PAYLOAD=$'\x01'

function __openui_sanitize_osc_value() {
  local value="$1"
  value="${value//$'\e'/}"
  value="${value//$'\a'/}"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  printf '%s' "$value"
}

function __openui_sanitize_command() {
  local value="$1"
  value="${value//$'\e'/}"
  value="${value//$'\a'/}"
  value="${value//$'\r\n'/$'\n'}"
  value="${value//$'\r'/$'\n'}"
  printf '%s' "$value"
}

function __openui_emit_completion_names() {
  emulate -L zsh
  local kind="$1"
  shift
  local name payload="" next
  integer count=0
  for name in "$@"; do
    [[ "$name" =~ '^([A-Za-z0-9_][A-Za-z0-9_.:+@%+-]{0,127}|\[)$' ]] || continue
    [[ "$name" == __openui_* ]] && continue
    [[ "$kind" == "variable" && "$name" == OPENUI_* ]] && continue
    if [[ -n "$payload" ]]; then
      next="$payload,$name"
    else
      next="$name"
    fi
    (( ${#next} <= 6000 )) || break
    payload="$next"
    (( count += 1 ))
    (( count < 512 )) || break
  done
  # A control-character sentinel cannot collide with a validated name payload.
  local previous="${__OPENUI_COMPLETION_PAYLOADS[$kind]-$'\x01'}"
  [[ "$previous" == "$payload" ]] && return 0
  __OPENUI_COMPLETION_PAYLOADS[$kind]="$payload"
  printf '\e]633;J;%s;%s;%s\a' "$__OPENUI_EPOCH_ID" "$kind" "$payload"
}

function __openui_emit_completion_context() {
  emulate -L zsh
  __openui_emit_completion_names alias ${(ok)aliases}
  __openui_emit_completion_names function ${(ok)functions}
  __openui_emit_completion_names builtin ${(ok)builtins}
  __openui_emit_completion_names keyword ${(ok)reswords}
  __openui_emit_completion_names variable ${(ok)parameters[(R)*export*]}
  __openui_emit_shell_environment PATH "${PATH-}"
  __openui_emit_shell_environment CDPATH "${CDPATH-}"
}

function __openui_refresh_completion_context() {
  emulate -L zsh
  __openui_emit_completion_names alias ${(ok)aliases}
  __openui_emit_completion_names function ${(ok)functions}
  __openui_emit_completion_names variable ${(ok)parameters[(R)*export*]}
  __openui_emit_shell_environment PATH "${PATH-}"
  __openui_emit_shell_environment CDPATH "${CDPATH-}"
}

function __openui_emit_shell_environment() {
  emulate -L zsh
  local key="$1" value
  [[ "$key" == "PATH" || "$key" == "CDPATH" ]] || return 0
  value="$(__openui_sanitize_osc_value "$2")"
  (( ${#value} <= 12000 )) || value=""
  local previous="${__OPENUI_SHELL_ENVIRONMENT_PAYLOADS[$key]-$'\x01'}"
  [[ "$previous" == "$value" ]] && return 0
  __OPENUI_SHELL_ENVIRONMENT_PAYLOADS[$key]="$value"
  printf '\e]633;L;%s;%s;%s\a' "$__OPENUI_EPOCH_ID" "$key" "$value"
}

function __openui_emit_autocd_capability() {
  local enabled=0
  [[ -o autocd ]] && enabled=1
  [[ "$__OPENUI_CAPABILITY_AUTOCD_PAYLOAD" == "$enabled" ]] && return 0
  __OPENUI_CAPABILITY_AUTOCD_PAYLOAD="$enabled"
  printf '\e]633;M;%s;autocd;%s\a' "$__OPENUI_EPOCH_ID" "$enabled"
}

function __openui_preexec() {
  local command="$1"
  printf '\e]633;E;%s\a' "$(__openui_sanitize_command "$command")"
  printf '\e]633;C;%s\a' "$__OPENUI_EPOCH_ID"
  __OPENUI_COMMAND_RUNNING=1
}

function __openui_precmd() {
  local exit_code=$?
  if (( __OPENUI_COMMAND_RUNNING )); then
    printf '\e]633;D;%d;%s\a' "$exit_code" "$__OPENUI_EPOCH_ID"
    __OPENUI_COMMAND_RUNNING=0
  fi
  if (( ! __OPENUI_READY )); then
    __OPENUI_READY=1
    printf '\e]633;I;zsh;%s\a' "$__OPENUI_EPOCH_ID"
    __openui_emit_completion_context
  else
    __openui_refresh_completion_context
  fi
  # Query outside the `emulate -L zsh` completion helpers so this reflects the
  # user's active option set rather than zsh's emulation defaults.
  __openui_emit_autocd_capability
  printf '\e]633;Q;%s;%s\a' "$__OPENUI_EPOCH_ID" "$(__openui_sanitize_osc_value "$PWD")"
  printf '\e]633;A;%s\a' "$__OPENUI_EPOCH_ID"
}

function __openui_zshexit() {
  local exit_code=$?
  printf '\e]633;X;%d;%s\a' "$exit_code" "$__OPENUI_EPOCH_ID"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __openui_preexec
add-zsh-hook precmd __openui_precmd
add-zsh-hook zshexit __openui_zshexit

# This integration is installed before the first user-visible command. Clear
# startup/source noise once, then let zsh render the real prompt normally.
printf '\e[3J\e[2J\e[H'
