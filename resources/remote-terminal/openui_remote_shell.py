#!/usr/bin/env python3
"""Launch the user's remote shell with OpenUI integration, without dotfile edits."""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def source_if_readable(path: Path) -> str:
    rendered = quote(str(path))
    return f"[[ -r {rendered} ]] && source {rendered}"


def prune_runtime(runtime_root: Path) -> None:
    cutoff = time.time() - 7 * 24 * 60 * 60
    try:
        for child in list(runtime_root.iterdir())[:256]:
            try:
                if child.is_dir() and not child.is_symlink() and child.stat().st_mtime < cutoff:
                    shutil.rmtree(child, ignore_errors=True)
            except OSError:
                pass
    except OSError:
        pass


def launch() -> int:
    home = Path.home()
    runtime_root = home / ".openui" / "remote-runtime"
    runtime_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(runtime_root, 0o700)
    prune_runtime(runtime_root)
    runtime = runtime_root / f"shell-{os.getpid()}-{secrets.token_hex(6)}"
    runtime.mkdir(mode=0o700)

    requested_shell = os.environ.get("SHELL") or "/bin/sh"
    shell = requested_shell if os.path.isabs(requested_shell) else (shutil.which(requested_shell) or requested_shell)
    shell_name = Path(shell).name.lower()
    supported = Path(shell).is_file() and os.access(shell, os.X_OK) and any(
        name in shell_name for name in ("zsh", "bash", "fish")
    )
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        return 0 if supported else 78
    environment = dict(os.environ)
    environment.pop("OPENUI_SHELL_SHIM_DIR", None)
    environment.pop("OPENUI_ORIGINAL_PATH", None)
    environment["TERM_PROGRAM"] = "OpenUI"
    environment["OPENUI_REMOTE_SHELL"] = "1"

    if "zsh" in shell_name and Path(shell).exists():
        user_zdotdir = Path(environment.get("ZDOTDIR") or home)
        files = {
            ".zshenv": "\n".join([source_if_readable(user_zdotdir / ".zshenv"), f"export ZDOTDIR={quote(str(runtime))}"]),
            ".zprofile": source_if_readable(user_zdotdir / ".zprofile"),
            ".zshrc": "\n".join([source_if_readable(user_zdotdir / ".zshrc"), f"source {quote(str(ROOT / 'openui.zsh'))}"]),
            ".zlogin": source_if_readable(user_zdotdir / ".zlogin"),
            ".zlogout": source_if_readable(user_zdotdir / ".zlogout"),
        }
        for name, content in files.items():
            path = runtime / name
            path.write_text(content + "\n", encoding="utf-8")
            os.chmod(path, 0o600)
        environment["ZDOTDIR"] = str(runtime)
        command = [shell, "-l"]
    elif "bash" in shell_name and Path(shell).exists():
        bashrc = runtime / "bashrc"
        bashrc.write_text("\n".join([
            source_if_readable(Path("/etc/profile")),
            f"if [[ -r {quote(str(home / '.bash_profile'))} ]]; then",
            f"  source {quote(str(home / '.bash_profile'))}",
            f"elif [[ -r {quote(str(home / '.bash_login'))} ]]; then",
            f"  source {quote(str(home / '.bash_login'))}",
            f"elif [[ -r {quote(str(home / '.profile'))} ]]; then",
            f"  source {quote(str(home / '.profile'))}",
            "fi",
            f"source {quote(str(ROOT / 'openui.bash'))}",
            "",
        ]), encoding="utf-8")
        os.chmod(bashrc, 0o600)
        command = [shell, "--rcfile", str(bashrc), "-i"]
    elif "fish" in shell_name and Path(shell).exists():
        command = [shell, "--init-command", f"source {quote(str(ROOT / 'openui.fish'))}", "-l"]
    else:
        command = [shell, "-l"] if Path(shell).exists() else ["/bin/sh", "-l"]

    try:
        return subprocess.call(command, env=environment)
    finally:
        shutil.rmtree(runtime, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(launch())
