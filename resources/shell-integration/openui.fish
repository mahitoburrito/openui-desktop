# OpenUI semantic shell integration for fish.
if set -q OPENUI_SHELL_SHIM_DIR; and test -d "$OPENUI_SHELL_SHIM_DIR"
    if test "$PATH[1]" != "$OPENUI_SHELL_SHIM_DIR"
        # Keep the change process-local. User config may have prepended system
        # directories after OpenUI constructed the PTY environment.
        set -gx PATH "$OPENUI_SHELL_SHIM_DIR" $PATH
    end
end

if set -q OPENUI_SHELL_INTEGRATION_LOADED
    printf '\e]633;I;fish;%s\a' $__OPENUI_EPOCH_ID
    return 0
end

set -g OPENUI_SHELL_INTEGRATION_LOADED 1
set -g __OPENUI_EPOCH_ID "fish-$fish_pid-"(random)
set -g __OPENUI_READY 0
set -g __OPENUI_COMPLETION_CACHE_KINDS
set -g __OPENUI_COMPLETION_CACHE_PAYLOADS
set -g __OPENUI_SHELL_ENVIRONMENT_KEYS
set -g __OPENUI_SHELL_ENVIRONMENT_PAYLOADS

function __openui_sanitize_osc_value
    string replace -a (printf '\e') '' -- $argv[1] |
        string replace -a (printf '\a') '' |
        string replace -a (printf '\r') ' ' |
        string replace -a (printf '\n') ' '
end

function __openui_sanitize_command
    string replace -a (printf '\e') '' -- $argv[1] |
        string replace -a (printf '\a') '' |
        string replace -a (printf '\r') ''
end

function __openui_emit_completion_names
    set -l kind $argv[1]
    set -l payload ''
    set -l count 0
    for name in $argv[2..-1]
        string match -rq '^(?:[A-Za-z0-9_][A-Za-z0-9_.:+@%+-]{0,127}|\[)$' -- $name; or continue
        string match -iq '__openui_*' -- $name; and continue
        string match -q '__fish_*' -- $name; and continue
        if test "$kind" = variable
            string match -iq 'OPENUI_*' -- $name; and continue
        end
        set -l next ''
        if test -n "$payload"
            set next "$payload,$name"
        else
            set next "$name"
        end
        test (string length -- "$next") -le 6000; or break
        set payload "$next"
        set count (math $count + 1)
        test $count -lt 512; or break
    end
    set -l cache_index (contains -i -- $kind $__OPENUI_COMPLETION_CACHE_KINDS)
    if test -n "$cache_index"
        if test "$__OPENUI_COMPLETION_CACHE_PAYLOADS[$cache_index]" = "$payload"
            return 0
        end
        set -g __OPENUI_COMPLETION_CACHE_PAYLOADS[$cache_index] "$payload"
    else
        set -ga __OPENUI_COMPLETION_CACHE_KINDS $kind
        set -ga __OPENUI_COMPLETION_CACHE_PAYLOADS "$payload"
    end
    printf '\e]633;J;%s;%s;%s\a' $__OPENUI_EPOCH_ID $kind $payload
end

function __openui_emit_completion_context
    __openui_emit_completion_names abbreviation (abbr --list 2>/dev/null)
    __openui_emit_completion_names function (functions --all --names 2>/dev/null)
    __openui_emit_completion_names builtin (builtin --names 2>/dev/null)
    __openui_emit_completion_names variable (set --names 2>/dev/null)
    __openui_emit_shell_environment PATH (string join : -- $PATH)
end

function __openui_refresh_completion_context
    __openui_emit_completion_names abbreviation (abbr --list 2>/dev/null)
    __openui_emit_completion_names function (functions --all --names 2>/dev/null)
    __openui_emit_completion_names variable (set --names 2>/dev/null)
    __openui_emit_shell_environment PATH (string join : -- $PATH)
end

function __openui_emit_shell_environment
    set -l key $argv[1]
    test "$key" = PATH; or return 0
    set -l value (__openui_sanitize_osc_value "$argv[2]")
    test (string length -- "$value") -le 12000; or set value ''
    set -l cache_index (contains -i -- $key $__OPENUI_SHELL_ENVIRONMENT_KEYS)
    if test -n "$cache_index"
        if test "$__OPENUI_SHELL_ENVIRONMENT_PAYLOADS[$cache_index]" = "$value"
            return 0
        end
        set -g __OPENUI_SHELL_ENVIRONMENT_PAYLOADS[$cache_index] "$value"
    else
        set -ga __OPENUI_SHELL_ENVIRONMENT_KEYS $key
        set -ga __OPENUI_SHELL_ENVIRONMENT_PAYLOADS "$value"
    end
    printf '\e]633;L;%s;%s;%s\a' $__OPENUI_EPOCH_ID $key $value
end

function __openui_preexec --on-event fish_preexec
    set -l command (__openui_sanitize_command "$argv" | string collect)
    printf '\e]633;E;%s\a' "$command"
    printf '\e]633;C;%s\a' $__OPENUI_EPOCH_ID
end

function __openui_postexec --on-event fish_postexec
    set -l exit_code $status
    if test $__OPENUI_READY -eq 1
        printf '\e]633;D;%d;%s\a' $exit_code $__OPENUI_EPOCH_ID
    end
end

# Fish does not emit fish_preexec, fish_postexec, or fish_prompt for a parser
# error. fish_posterror supplies the rejected command, so synthesize the one
# missing command lifecycle with Fish's documented generic syntax-error status.
function __openui_posterror --on-event fish_posterror
    if test $__OPENUI_READY -eq 1
        set -l command (__openui_sanitize_command "$argv" | string collect)
        printf '\e]633;E;%s\a' "$command"
        printf '\e]633;C;%s\a' $__OPENUI_EPOCH_ID
        printf '\e]633;D;1;%s\a' $__OPENUI_EPOCH_ID
    end
end

function __openui_prompt --on-event fish_prompt
    if test $__OPENUI_READY -eq 0
        set -g __OPENUI_READY 1
        printf '\e]633;I;fish;%s\a' $__OPENUI_EPOCH_ID
        __openui_emit_completion_context
    else
        __openui_refresh_completion_context
    end
    printf '\e]633;Q;%s;%s\a' $__OPENUI_EPOCH_ID (__openui_sanitize_osc_value "$PWD")
    printf '\e]633;A;%s\a' $__OPENUI_EPOCH_ID
end

function __openui_exit --on-event fish_exit
    set -l exit_code $status
    printf '\e]633;X;%d;%s\a' $exit_code $__OPENUI_EPOCH_ID
end

printf '\e[3J\e[2J\e[H'
