# OpenUI semantic shell integration for Windows PowerShell and pwsh.
if ($env:OPENUI_SHELL_SHIM_DIR -and (Test-Path -LiteralPath $env:OPENUI_SHELL_SHIM_DIR -PathType Container)) {
  $pathSeparator = [string][IO.Path]::PathSeparator
  $firstPathEntry = @($env:PATH -split [regex]::Escape($pathSeparator))[0]
  if ($firstPathEntry -ne $env:OPENUI_SHELL_SHIM_DIR) {
    # Profiles can rewrite PATH after OpenUI creates the PTY. Restore the
    # private shim directory without changing any machine or user setting.
    $env:PATH = "$($env:OPENUI_SHELL_SHIM_DIR)$pathSeparator$($env:PATH)"
  }
}

if ($global:OPENUI_SHELL_INTEGRATION_LOADED) {
  [Console]::Write("$([char]27)]633;I;powershell;$global:OpenUIEpochId$([char]7)")
  return
}

$global:OPENUI_SHELL_INTEGRATION_LOADED = $true
$global:OpenUIEscape = [char]27
$global:OpenUIBell = [char]7
$global:OpenUIEpochId = "powershell-$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$global:OpenUIOriginalPrompt = $function:prompt
$global:OpenUISeenPrompt = $false
$global:OpenUILastHistoryId = $null
$global:OpenUIShellIntegrationCommand = ". '" + $PSCommandPath.Replace("'", "''") + "'"
$global:OpenUICurrentPowerShellExecutable = (Get-Process -Id $PID).Path
$global:OpenUICompletionPayloads = @{}
$global:OpenUIShellEnvironmentPayloads = @{}

# PSReadLine owns PowerShell's grammar-continuation prompt. Prefix its current
# process-local value with an OSC marker so OpenUI can append physical lines to
# one command without mistaking stdin sent to a running program for command
# history. Unsupported/non-PSReadLine hosts retain their ordinary behavior.
try {
  $continuationPrompt = (Get-PSReadLineOption -ErrorAction Stop).ContinuationPrompt
  $continuationMarker = "$global:OpenUIEscape]633;N;$global:OpenUIEpochId$global:OpenUIBell"
  Set-PSReadLineOption -ContinuationPrompt "$continuationMarker$continuationPrompt" -ErrorAction Stop
} catch {}

function global:__openui_write_osc {
  param([string]$Payload)
  [Console]::Write("$global:OpenUIEscape]633;$Payload$global:OpenUIBell")
}

function global:__openui_emit_completion_names {
  param([string]$Kind, [object[]]$Names)
  $safeNames = [Collections.Generic.List[string]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $payloadLength = 0
  foreach ($rawName in $Names) {
    $name = [string]$rawName
    if ($name -notmatch '^(?:[A-Za-z0-9_][A-Za-z0-9_.:+@%+\-]{0,127}|\[)$') { continue }
    if ($name -match '^__openui_') { continue }
    if ($Kind -eq 'variable' -and $name -match '^OPENUI_') { continue }
    if (-not $seen.Add($name)) { continue }
    $nextLength = $payloadLength + $(if ($safeNames.Count -gt 0) { 1 } else { 0 }) + $name.Length
    if ($nextLength -gt 6000) { break }
    $null = $safeNames.Add($name)
    $payloadLength = $nextLength
    if ($safeNames.Count -ge 512) { break }
  }
  $safeNames.Sort([StringComparer]::OrdinalIgnoreCase)
  $payload = $safeNames -join ','
  if ($global:OpenUICompletionPayloads.ContainsKey($Kind) -and
      [string]$global:OpenUICompletionPayloads[$Kind] -ceq $payload) {
    return
  }
  $global:OpenUICompletionPayloads[$Kind] = $payload
  __openui_write_osc "J;$global:OpenUIEpochId;$Kind;$payload"
}

function global:__openui_emit_completion_context {
  try {
    __openui_emit_completion_names alias @(
      Get-Alias -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
    )
  } catch { __openui_emit_completion_names alias @() }
  try {
    __openui_emit_completion_names function @(
      Get-ChildItem Function: -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
    )
  } catch { __openui_emit_completion_names function @() }
  try {
    # -ListImported restricts this to modules already loaded in the session.
    # Without it Get-Command walks the whole PSModulePath and loads metadata for
    # every installed module. On a machine carrying the Az or AWS.Tools module
    # sets that is tens of thousands of cmdlets and takes about a minute, which
    # the user experiences as the shell hanging on its very first prompt.
    #
    # It also fixes what got emitted. The payload cap keeps the first names that
    # fit, so a full enumeration yielded 196 entries every one of which began
    # "Add-A" — the alphabetical head of the AWS and Az module sets, and not a
    # single core cmdlet. Imported-only gives the commands actually in play.
    #
    # -TotalCount stops the pipeline early; the cap in
    # __openui_emit_completion_names still bounds the payload as before.
    __openui_emit_completion_names builtin @(
      Get-Command -CommandType Cmdlet -ListImported -TotalCount 512 -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Name }
    )
  } catch { __openui_emit_completion_names builtin @() }
  try {
    __openui_emit_completion_names variable @(
      Get-ChildItem Env: -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
    )
  } catch { __openui_emit_completion_names variable @() }
  __openui_emit_shell_environment PATH $env:PATH
  __openui_emit_shell_environment PATHEXT $env:PATHEXT
}

function global:__openui_refresh_completion_context {
  # Cmdlet names are stable for the process. Aliases, functions, and
  # environment-variable names can be added or removed interactively.
  try {
    __openui_emit_completion_names alias @(
      Get-Alias -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
    )
  } catch { __openui_emit_completion_names alias @() }
  try {
    __openui_emit_completion_names function @(
      Get-ChildItem Function: -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
    )
  } catch { __openui_emit_completion_names function @() }
  try {
    __openui_emit_completion_names variable @(
      Get-ChildItem Env: -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
    )
  } catch { __openui_emit_completion_names variable @() }
  __openui_emit_shell_environment PATH $env:PATH
  __openui_emit_shell_environment PATHEXT $env:PATHEXT
}

function global:__openui_emit_shell_environment {
  param([string]$Key, [AllowNull()][string]$Value)
  if ($Key -notin @('PATH', 'PATHEXT')) { return }
  $safeValue = ([string]$Value).
    Replace(([char]27).ToString(), '').
    Replace(([char]7).ToString(), '').
    Replace("`r", ' ').
    Replace("`n", ' ')
  if ($safeValue.Length -gt 12000) { $safeValue = '' }
  if ($global:OpenUIShellEnvironmentPayloads.ContainsKey($Key) -and
      [string]$global:OpenUIShellEnvironmentPayloads[$Key] -ceq $safeValue) {
    return
  }
  $global:OpenUIShellEnvironmentPayloads[$Key] = $safeValue
  __openui_write_osc "L;$global:OpenUIEpochId;$Key;$safeValue"
}

function global:__openui_launch_powershell_child {
  $Executable = [string]$args[0]
  $ForwardedArguments = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }
  $passthrough = $false
  foreach ($argument in $ForwardedArguments) {
    $value = ([string]$argument).ToLowerInvariant()
    if ($value -in @(
      '-c', '-command', '-commandwithargs',
      '-e', '-encodedcommand',
      '-f', '-file',
      '-noninteractive',
      '-h', '-help', '-?',
      '-v', '-version'
    )) {
      $passthrough = $true
      break
    }
    if ($value -notlike '-*') {
      # A positional script/argument is not an ordinary interactive launch.
      $passthrough = $true
      break
    }
  }
  if ($passthrough) {
    & $Executable @ForwardedArguments
  } else {
    & $Executable @ForwardedArguments -NoExit -Command $global:OpenUIShellIntegrationCommand
  }
}

$currentPowerShellName = [IO.Path]::GetFileNameWithoutExtension($global:OpenUICurrentPowerShellExecutable)
if ($currentPowerShellName -ieq 'pwsh') {
  function global:pwsh {
    __openui_launch_powershell_child $global:OpenUICurrentPowerShellExecutable @args
  }
} elseif ($currentPowerShellName -ieq 'powershell') {
  function global:powershell {
    __openui_launch_powershell_child $global:OpenUICurrentPowerShellExecutable @args
  }
}

function global:prompt {
  $lastCommandSucceeded = $?
  $exitCode = if ($lastCommandSucceeded) {
    0
  } elseif ($null -eq $global:LASTEXITCODE) {
    1
  } else {
    $global:LASTEXITCODE
  }
  $cwd = (Get-Location).Path.Replace(([char]27).ToString(), '').Replace(([char]7).ToString(), '')
  $historyItem = Get-History -Count 1 -ErrorAction SilentlyContinue
  $historyId = if ($historyItem) { [long]$historyItem.Id } else { $null }
  if ($global:OpenUISeenPrompt) {
    # PSReadLine history filters can intentionally exclude the command that
    # just ran. Reconcile command text only when the history ID advances, or a
    # stale entry would overwrite the block inferred from actual PTY input.
    $historyAdvanced = $historyItem -and (
      $null -eq $global:OpenUILastHistoryId -or $historyId -gt $global:OpenUILastHistoryId
    )
    if ($historyAdvanced -and $historyItem.CommandLine) {
      $commandLine = $historyItem.CommandLine.Replace(([char]27).ToString(), '').Replace(([char]7).ToString(), '').Replace("`r`n", "`n").Replace("`r", "`n")
      __openui_write_osc "E;$commandLine"
    }
    __openui_write_osc "D;$exitCode;$global:OpenUIEpochId"
    __openui_refresh_completion_context
  } else {
    $global:OpenUISeenPrompt = $true
    __openui_write_osc "I;powershell;$global:OpenUIEpochId"
    __openui_emit_completion_context
  }
  $global:OpenUILastHistoryId = $historyId
  __openui_write_osc "Q;$global:OpenUIEpochId;$cwd"
  __openui_write_osc "A;$global:OpenUIEpochId"
  if ($global:OpenUIOriginalPrompt) { & $global:OpenUIOriginalPrompt } else { "PS $cwd> " }
}

Register-EngineEvent -SourceIdentifier PowerShell.Exiting -SupportEvent -Action {
  # PowerShell.Exiting exposes no trustworthy process exit code. Emit an empty
  # field so OpenUI records the final child command as unknown; the parent
  # shell's normal completion event will still carry the child process status.
  [Console]::Write("$global:OpenUIEscape]633;X;;$global:OpenUIEpochId$global:OpenUIBell")
} | Out-Null

[Console]::Write("$global:OpenUIEscape[3J$global:OpenUIEscape[2J$global:OpenUIEscape[H")
