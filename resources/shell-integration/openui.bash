# OpenUI semantic shell integration for Bash. Command text is inferred from
# PTY input; PROMPT_COMMAND supplies authoritative completion and cwd evidence
# without replacing a user's DEBUG trap.
if [[ -n "${OPENUI_SHELL_SHIM_DIR:-}" && -d "$OPENUI_SHELL_SHIM_DIR" ]]; then
  case "$PATH" in
    "$OPENUI_SHELL_SHIM_DIR"|"$OPENUI_SHELL_SHIM_DIR":*) ;;
    *) export PATH="$OPENUI_SHELL_SHIM_DIR:$PATH" ;;
  esac
  # Bash caches resolved executables; discard entries resolved before user
  # startup files finished changing PATH.
  hash -r
fi

if [[ -n "${OPENUI_SHELL_INTEGRATION_LOADED:-}" ]]; then
  printf '\e]633;I;bash;%s\a' "$__OPENUI_EPOCH_ID"
  return 0
fi

OPENUI_SHELL_INTEGRATION_LOADED=1
__OPENUI_EPOCH_ID="bash-$$-$RANDOM"
__OPENUI_SEEN_PROMPT=0
__OPENUI_LAST_HISTORY_NUMBER=""
__OPENUI_CAPTURED_HISTORY_NUMBER=""
__OPENUI_CAPTURED_HISTORY_COMMAND=""
__OPENUI_PREVIOUS_EXIT_TRAP="$(trap -p EXIT)"
__OPENUI_COMPLETION_ALIAS_INITIALIZED=0
__OPENUI_COMPLETION_FUNCTION_INITIALIZED=0
__OPENUI_COMPLETION_BUILTIN_INITIALIZED=0
__OPENUI_COMPLETION_KEYWORD_INITIALIZED=0
__OPENUI_COMPLETION_VARIABLE_INITIALIZED=0
__OPENUI_COMPLETION_ALIAS_PAYLOAD=""
__OPENUI_COMPLETION_FUNCTION_PAYLOAD=""
__OPENUI_COMPLETION_BUILTIN_PAYLOAD=""
__OPENUI_COMPLETION_KEYWORD_PAYLOAD=""
__OPENUI_COMPLETION_VARIABLE_PAYLOAD=""
__OPENUI_ENVIRONMENT_PATH_INITIALIZED=0
__OPENUI_ENVIRONMENT_PATH_PAYLOAD=""
__OPENUI_ENVIRONMENT_CDPATH_INITIALIZED=0
__OPENUI_ENVIRONMENT_CDPATH_PAYLOAD=""
__OPENUI_CAPABILITY_AUTOCD_INITIALIZED=0
__OPENUI_CAPABILITY_AUTOCD_PAYLOAD=""
declare -a __OPENUI_USER_PROMPT_COMMANDS=()

# Prefix the user's continuation prompt with an invisible epoch-scoped marker.
# OpenUI can then distinguish shell grammar continuation from stdin typed into
# a running program without changing the visible PS2 text.
PS2=$'\\[\e]633;N;'"${__OPENUI_EPOCH_ID}"$'\a\\]'"${PS2-}"

__openui_sanitize_osc_value() {
  local value="$1"
  value="${value//$'\e'/}"
  value="${value//$'\a'/}"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  printf '%s' "$value"
}

__openui_sanitize_command() {
  local value="$1"
  value="${value//$'\e'/}"
  value="${value//$'\a'/}"
  value="${value//$'\r\n'/$'\n'}"
  value="${value//$'\r'/$'\n'}"
  printf '%s' "$value"
}

__openui_emit_completion_names() {
  local kind="$1"
  local name payload="" next count=0 initialized previous
  while IFS= read -r name; do
    [[ "$name" =~ ^([A-Za-z0-9_][A-Za-z0-9_.:+@%+-]{0,127}|\[)$ ]] || continue
    [[ "$name" == __openui_* ]] && continue
    [[ "$kind" == "variable" && "$name" == OPENUI_* ]] && continue
    if [[ -n "$payload" ]]; then
      next="$payload,$name"
    else
      next="$name"
    fi
    (( ${#next} <= 6000 )) || break
    payload="$next"
    count=$((count + 1))
    (( count < 512 )) || break
  done

  case "$kind" in
    alias)
      initialized=$__OPENUI_COMPLETION_ALIAS_INITIALIZED
      previous="$__OPENUI_COMPLETION_ALIAS_PAYLOAD"
      ;;
    function)
      initialized=$__OPENUI_COMPLETION_FUNCTION_INITIALIZED
      previous="$__OPENUI_COMPLETION_FUNCTION_PAYLOAD"
      ;;
    builtin)
      initialized=$__OPENUI_COMPLETION_BUILTIN_INITIALIZED
      previous="$__OPENUI_COMPLETION_BUILTIN_PAYLOAD"
      ;;
    keyword)
      initialized=$__OPENUI_COMPLETION_KEYWORD_INITIALIZED
      previous="$__OPENUI_COMPLETION_KEYWORD_PAYLOAD"
      ;;
    variable)
      initialized=$__OPENUI_COMPLETION_VARIABLE_INITIALIZED
      previous="$__OPENUI_COMPLETION_VARIABLE_PAYLOAD"
      ;;
    *) return 0 ;;
  esac
  if (( initialized )) && [[ "$previous" == "$payload" ]]; then
    return 0
  fi
  case "$kind" in
    alias)
      __OPENUI_COMPLETION_ALIAS_INITIALIZED=1
      __OPENUI_COMPLETION_ALIAS_PAYLOAD="$payload"
      ;;
    function)
      __OPENUI_COMPLETION_FUNCTION_INITIALIZED=1
      __OPENUI_COMPLETION_FUNCTION_PAYLOAD="$payload"
      ;;
    builtin)
      __OPENUI_COMPLETION_BUILTIN_INITIALIZED=1
      __OPENUI_COMPLETION_BUILTIN_PAYLOAD="$payload"
      ;;
    keyword)
      __OPENUI_COMPLETION_KEYWORD_INITIALIZED=1
      __OPENUI_COMPLETION_KEYWORD_PAYLOAD="$payload"
      ;;
    variable)
      __OPENUI_COMPLETION_VARIABLE_INITIALIZED=1
      __OPENUI_COMPLETION_VARIABLE_PAYLOAD="$payload"
      ;;
  esac
  printf '\e]633;J;%s;%s;%s\a' "$__OPENUI_EPOCH_ID" "$kind" "$payload"
}

__openui_emit_completion_context() {
  __openui_emit_completion_names alias < <(compgen -a 2>/dev/null)
  __openui_emit_completion_names function < <(compgen -A function 2>/dev/null)
  __openui_emit_completion_names builtin < <(compgen -b 2>/dev/null)
  __openui_emit_completion_names keyword < <(compgen -k 2>/dev/null)
  __openui_emit_completion_names variable < <(compgen -e 2>/dev/null)
  __openui_emit_shell_environment PATH "${PATH-}"
  __openui_emit_shell_environment CDPATH "${CDPATH-}"
}

__openui_refresh_completion_context() {
  # These categories can change during an interactive session. Builtins and
  # keywords are shell-version constants and are intentionally bootstrap-only.
  __openui_emit_completion_names alias < <(compgen -a 2>/dev/null)
  __openui_emit_completion_names function < <(compgen -A function 2>/dev/null)
  __openui_emit_completion_names variable < <(compgen -e 2>/dev/null)
  __openui_emit_shell_environment PATH "${PATH-}"
  __openui_emit_shell_environment CDPATH "${CDPATH-}"
}

__openui_emit_shell_environment() {
  local key="$1" value initialized previous
  value="$(__openui_sanitize_osc_value "$2")"
  if (( ${#value} > 12000 )); then
    value=""
  fi
  case "$key" in
    PATH)
      initialized=$__OPENUI_ENVIRONMENT_PATH_INITIALIZED
      previous="$__OPENUI_ENVIRONMENT_PATH_PAYLOAD"
      ;;
    CDPATH)
      initialized=$__OPENUI_ENVIRONMENT_CDPATH_INITIALIZED
      previous="$__OPENUI_ENVIRONMENT_CDPATH_PAYLOAD"
      ;;
    *) return 0 ;;
  esac
  if (( initialized )) && [[ "$previous" == "$value" ]]; then
    return 0
  fi
  case "$key" in
    PATH)
      __OPENUI_ENVIRONMENT_PATH_INITIALIZED=1
      __OPENUI_ENVIRONMENT_PATH_PAYLOAD="$value"
      ;;
    CDPATH)
      __OPENUI_ENVIRONMENT_CDPATH_INITIALIZED=1
      __OPENUI_ENVIRONMENT_CDPATH_PAYLOAD="$value"
      ;;
  esac
  printf '\e]633;L;%s;%s;%s\a' "$__OPENUI_EPOCH_ID" "$key" "$value"
}

__openui_emit_autocd_capability() {
  local enabled=0
  if shopt -q autocd 2>/dev/null; then
    enabled=1
  fi
  if (( __OPENUI_CAPABILITY_AUTOCD_INITIALIZED )) &&
     [[ "$__OPENUI_CAPABILITY_AUTOCD_PAYLOAD" == "$enabled" ]]; then
    return 0
  fi
  __OPENUI_CAPABILITY_AUTOCD_INITIALIZED=1
  __OPENUI_CAPABILITY_AUTOCD_PAYLOAD="$enabled"
  printf '\e]633;M;%s;autocd;%s\a' "$__OPENUI_EPOCH_ID" "$enabled"
}

__openui_capture_last_history() {
  local value digits
  __OPENUI_CAPTURED_HISTORY_NUMBER=""
  __OPENUI_CAPTURED_HISTORY_COMMAND=""
  value="$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)"
  value="${value#"${value%%[![:space:]]*}"}"
  digits="${value%%[!0-9]*}"
  [[ -n "$digits" ]] || return 0
  value="${value#"$digits"}"
  value="${value#\*}"
  value="${value#"${value%%[![:space:]]*}"}"
  __OPENUI_CAPTURED_HISTORY_NUMBER="$digits"
  __OPENUI_CAPTURED_HISTORY_COMMAND="$(__openui_sanitize_command "$value")"
}

__openui_prompt_command() {
  local exit_code="${1-$?}"
  __openui_capture_last_history
  if (( __OPENUI_SEEN_PROMPT )); then
    # HISTCONTROL, HISTIGNORE, duplicate suppression, or a user history hook
    # may intentionally omit the command that just ran. Only treat history as
    # authoritative when its monotonically increasing entry number advances;
    # otherwise keep OpenUI's inferred input instead of renaming the block to
    # an older command.
    if [[ "$__OPENUI_CAPTURED_HISTORY_NUMBER" =~ ^[0-9]+$ ]] &&
       { [[ ! "$__OPENUI_LAST_HISTORY_NUMBER" =~ ^[0-9]+$ ]] ||
         (( __OPENUI_CAPTURED_HISTORY_NUMBER > __OPENUI_LAST_HISTORY_NUMBER )); }; then
      if [[ -n "$__OPENUI_CAPTURED_HISTORY_COMMAND" ]]; then
        printf '\e]633;E;%s\a' "$__OPENUI_CAPTURED_HISTORY_COMMAND"
      fi
    fi
    printf '\e]633;D;%d;%s\a' "$exit_code" "$__OPENUI_EPOCH_ID"
    __openui_refresh_completion_context
  else
    __OPENUI_SEEN_PROMPT=1
    printf '\e]633;I;bash;%s\a' "$__OPENUI_EPOCH_ID"
    __openui_emit_completion_context
  fi
  __openui_emit_autocd_capability
  __OPENUI_LAST_HISTORY_NUMBER="$__OPENUI_CAPTURED_HISTORY_NUMBER"
  printf '\e]633;Q;%s;%s\a' "$__OPENUI_EPOCH_ID" "$(__openui_sanitize_osc_value "$PWD")"
  printf '\e]633;A;%s\a' "$__OPENUI_EPOCH_ID"
  return "$exit_code"
}

__openui_restore_status() {
  return "$1"
}

__openui_prompt_dispatch() {
  local exit_code=$?
  local command
  __openui_prompt_command "$exit_code"
  if (( ${#__OPENUI_USER_PROMPT_COMMANDS[@]} == 0 )); then
    return "$exit_code"
  fi

  # PROMPT_COMMAND array elements and DEBUG traps can otherwise observe the
  # integration function's successful helper commands instead of the user's
  # command status. Restore it immediately before entering the preserved user
  # sequence; subsequent elements retain Bash's ordinary left-to-right status.
  __openui_restore_status "$exit_code"
  for command in "${__OPENUI_USER_PROMPT_COMMANDS[@]}"; do
    eval "$command"
  done
}

__openui_shell_exit() {
  local exit_code=$?
  printf '\e]633;X;%d;%s\a' "$exit_code" "$__OPENUI_EPOCH_ID"
  if [[ -n "$__OPENUI_PREVIOUS_EXIT_TRAP" ]]; then
    local previous_handler="${__OPENUI_PREVIOUS_EXIT_TRAP#trap -- \'}"
    previous_handler="${previous_handler%\' EXIT}"
    (exit "$exit_code")
    eval "$previous_handler"
  fi
}

if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
  __OPENUI_USER_PROMPT_COMMANDS=("${PROMPT_COMMAND[@]}")
elif [[ -n "${PROMPT_COMMAND:-}" ]]; then
  __OPENUI_USER_PROMPT_COMMANDS=("$PROMPT_COMMAND")
fi
PROMPT_COMMAND="__openui_prompt_dispatch"
trap '__openui_shell_exit' EXIT

printf '\e[3J\e[2J\e[H'
