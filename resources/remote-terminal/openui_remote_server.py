#!/usr/bin/env python3
"""OpenUI's remote command server.

The transport is intentionally tiny: four-byte little-endian frame length
followed by UTF-8 JSON. Requests are correlated by numeric id, commands never
pass through a shell, and every process belongs to its own process group so an
abort or timeout cannot leave grandchildren behind.
"""

from __future__ import annotations

import json
import base64
import mimetypes
import os
import selectors
import signal
import struct
import subprocess
import sys
import threading
import time
from typing import Any


PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 512 * 1024
MAX_ARGS = 128
MAX_ENVIRONMENT = 512
MAX_OUTPUT_BYTES = 256 * 1024
MAX_TIMEOUT_MS = 30_000
MAX_STDIN_BYTES = 256 * 1024
MAX_FILE_BYTES = 256 * 1024
MAX_BATCH_BYTES = 320 * 1024
MAX_FILE_SCAN_BYTES = 16 * 1024 * 1024
MAX_FILES = 32
MAX_RANGES = 32

write_lock = threading.Lock()
process_lock = threading.Lock()
running: dict[int, subprocess.Popen[bytes]] = {}
cancellations: dict[int, threading.Event] = {}


def write_message(message: dict[str, Any]) -> None:
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        payload = json.dumps({
            "id": message.get("id"),
            "type": "error",
            "error": "response_too_large",
        }, separators=(",", ":")).encode("utf-8")
    with write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(payload)))
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()


def read_exact(length: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def valid_text(value: Any, maximum: int) -> str | None:
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        return None
    return value


def terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except (ProcessLookupError, PermissionError):
        pass


def execute(request: dict[str, Any]) -> None:
    request_id = request["id"]
    executable = valid_text(request.get("executable"), 4096)
    raw_args = request.get("args", [])
    cwd = valid_text(request.get("cwd"), 16384)
    raw_environment = request.get("environment", {})
    raw_stdin = request.get("stdin")
    if (
        executable is None
        or not isinstance(raw_args, list)
        or len(raw_args) > MAX_ARGS
        or any(valid_text(arg, 32768) is None for arg in raw_args)
        or cwd is None
        or not isinstance(raw_environment, dict)
        or len(raw_environment) > MAX_ENVIRONMENT
        or (raw_stdin is not None and (not isinstance(raw_stdin, str) or len(raw_stdin.encode("utf-8")) > MAX_STDIN_BYTES))
    ):
        write_message({"id": request_id, "type": "error", "error": "invalid_request"})
        return

    environment = dict(os.environ)
    for key, value in raw_environment.items():
        if (
            not isinstance(key, str)
            or not key
            or len(key) > 128
            or not key.replace("_", "A").isalnum()
            or not isinstance(value, str)
            or len(value) > 32768
            or "\x00" in value
        ):
            write_message({"id": request_id, "type": "error", "error": "invalid_environment"})
            return
        environment[key] = value

    try:
        timeout_ms = max(50, min(MAX_TIMEOUT_MS, int(request.get("timeoutMs", 2000))))
        output_limit = max(1024, min(MAX_OUTPUT_BYTES, int(request.get("maxOutputBytes", MAX_OUTPUT_BYTES))))
    except (TypeError, ValueError):
        write_message({"id": request_id, "type": "error", "error": "invalid_limits"})
        return

    try:
        process = subprocess.Popen(
            [executable, *raw_args],
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE if raw_stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=(os.name == "posix"),
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError) as error:
        write_message({
            "id": request_id,
            "type": "run_result",
            "exitCode": None,
            "stdout": "",
            "stderr": str(error)[:4096],
            "timedOut": False,
            "truncated": False,
        })
        return

    with process_lock:
        running[request_id] = process

    if raw_stdin is not None:
        def send_stdin() -> None:
            try:
                assert process.stdin is not None
                process.stdin.write(raw_stdin.encode("utf-8"))
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass

        threading.Thread(target=send_stdin, daemon=True).start()

    stdout = bytearray()
    stderr = bytearray()
    truncated = False
    timed_out = False
    selector = selectors.DefaultSelector()
    assert process.stdout is not None and process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, stdout)
    selector.register(process.stderr, selectors.EVENT_READ, stderr)
    deadline = time.monotonic() + timeout_ms / 1000
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                terminate_process(process)
                break
            events = selector.select(min(0.1, remaining))
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                destination: bytearray = key.data
                available = output_limit - len(stdout) - len(stderr)
                if available <= 0:
                    truncated = True
                    terminate_process(process)
                    break
                destination.extend(chunk[:available])
                if len(chunk) > available:
                    truncated = True
                    terminate_process(process)
                    break
            if truncated:
                break
            if process.poll() is not None and not events:
                # One final select cycle drains bytes written immediately
                # before process exit.
                continue
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            terminate_process(process)
            process.wait(timeout=1)
    finally:
        selector.close()
        with process_lock:
            running.pop(request_id, None)

    write_message({
        "id": request_id,
        "type": "run_result",
        "exitCode": process.returncode,
        "stdout": bytes(stdout).decode("utf-8", "replace"),
        "stderr": bytes(stderr).decode("utf-8", "replace"),
        "timedOut": timed_out,
        "truncated": truncated,
    })


def read_files(request: dict[str, Any], cancelled: threading.Event) -> None:
    request_id = request["id"]
    root = valid_text(request.get("root"), 16384)
    files = request.get("files")
    if root is None or not isinstance(files, list) or not files or len(files) > MAX_FILES:
        write_message({"id": request_id, "type": "error", "error": "invalid_request"})
        with process_lock:
            cancellations.pop(request_id, None)
        return
    try:
        real_root = os.path.realpath(root)
        if not os.path.isdir(real_root):
            raise OSError("invalid root")
        max_file_bytes = max(1, min(MAX_FILE_BYTES, int(request.get("maxFileBytes", 128 * 1024))))
        max_batch_bytes = max(1, min(MAX_BATCH_BYTES, int(request.get("maxBatchBytes", 256 * 1024))))
    except (OSError, TypeError, ValueError):
        write_message({"id": request_id, "type": "error", "error": "invalid_root_or_limits"})
        with process_lock:
            cancellations.pop(request_id, None)
        return

    include_binary = request.get("includeBinary") is True
    successes: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    remaining = max_batch_bytes

    def failed(path: str, code: str, message: str) -> None:
        failures.append({"path": path, "code": code, "message": message})

    def inside_root(path: str) -> bool:
        try:
            return os.path.commonpath([real_root, path]) == real_root
        except ValueError:
            return False

    def decode_prefix(raw: bytes) -> tuple[str | None, int]:
        for trim in range(0, min(4, len(raw) + 1)):
            try:
                end = len(raw) - trim
                return raw[:end].decode("utf-8"), end
            except UnicodeDecodeError:
                continue
        return None, 0

    for item in files:
        if cancelled.is_set():
            failed("", "cancelled", "Read request was cancelled")
            break
        if remaining <= 0:
            path_value = item.get("path", "") if isinstance(item, dict) else ""
            failed(path_value if isinstance(path_value, str) else "", "budget_exhausted", "Batch byte budget is exhausted")
            continue
        if not isinstance(item, dict):
            failed("", "invalid_path", "File entry must be an object")
            continue
        path_value = item.get("path")
        ranges = item.get("lineRanges", [])
        if (
            not isinstance(path_value, str) or not path_value or len(path_value) > 4096 or
            any(ord(char) < 32 or ord(char) == 127 for char in path_value) or
            not isinstance(ranges, list) or len(ranges) > MAX_RANGES
        ):
            failed(path_value if isinstance(path_value, str) else "", "invalid_path", "Invalid file path or line range")
            continue
        valid_ranges: list[tuple[int, int]] = []
        invalid_range = False
        for line_range in ranges:
            if (
                not isinstance(line_range, dict) or not isinstance(line_range.get("start"), int) or
                not isinstance(line_range.get("end"), int) or line_range["start"] < 1 or
                line_range["end"] < line_range["start"] or line_range["end"] > 1_000_000
            ):
                invalid_range = True
                break
            valid_ranges.append((line_range["start"], line_range["end"]))
        if invalid_range:
            failed(path_value, "invalid_path", "Invalid line range")
            continue
        lexical = os.path.abspath(path_value if os.path.isabs(path_value) else os.path.join(real_root, path_value))
        if not inside_root(lexical):
            failed(path_value, "outside_root", "Path leaves the session root")
            continue
        try:
            path = os.path.realpath(lexical)
            if not inside_root(path):
                failed(path_value, "outside_root", "Resolved path leaves the session root")
                continue
            stat = os.stat(path)
            if not os.path.isfile(path):
                failed(path_value, "not_file", "Path is not a regular file")
                continue
        except FileNotFoundError:
            failed(path_value, "not_found", "File not found")
            continue
        except OSError:
            failed(path_value, "io_error", "File metadata could not be read")
            continue

        file_budget = min(max_file_bytes, remaining)
        try:
            with open(path, "rb") as handle:
                prefix = handle.read(min(stat.st_size, 8192))
            extension = os.path.splitext(path)[1].lower()
            is_binary = b"\x00" in prefix
            if not is_binary:
                is_binary = decode_prefix(prefix)[0] is None
            is_binary = is_binary or extension in {
                ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".db", ".dmg", ".doc", ".docx",
                ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4",
                ".o", ".pdf", ".png", ".ppt", ".pptx", ".pyc", ".so", ".sqlite", ".tar", ".tgz",
                ".wasm", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
            }
            relative_path = os.path.relpath(path, real_root).replace(os.sep, "/")
            common = {
                "path": path,
                "relativePath": relative_path,
                "size": stat.st_size,
                "modified": stat.st_mtime * 1000,
            }
            if is_binary:
                if not include_binary:
                    failed(path_value, "binary_disallowed", "Binary reads require includeBinary=true")
                    continue
                with open(path, "rb") as handle:
                    raw = handle.read(file_budget)
                successes.append({
                    **common,
                    "kind": "binary",
                    "mime": mimetypes.guess_type(path)[0] or "application/octet-stream",
                    "base64": base64.b64encode(raw).decode("ascii"),
                    "truncated": stat.st_size > len(raw),
                })
                remaining -= len(raw)
                continue

            if valid_ranges:
                if stat.st_size > MAX_FILE_SCAN_BYTES:
                    failed(path_value, "scan_limit", "Line-range scan exceeds the bounded file size")
                    continue
                with open(path, "rb") as handle:
                    raw = handle.read()
                try:
                    content = raw.decode("utf-8")
                except UnicodeDecodeError:
                    failed(path_value, "binary_disallowed", "File is not valid UTF-8 text")
                    continue
                lines = content.splitlines()
                segments = []
                used = 0
                truncated = False
                for start, end in valid_ranges:
                    selected = "\n".join(lines[start - 1:min(end, len(lines))]) if start <= len(lines) else ""
                    encoded = selected.encode("utf-8")
                    available = file_budget - used
                    if len(encoded) > available:
                        encoded = encoded[:available]
                        while encoded:
                            try:
                                selected = encoded.decode("utf-8")
                                break
                            except UnicodeDecodeError:
                                encoded = encoded[:-1]
                        truncated = True
                    segments.append({"content": selected, "lineStart": start, "lineEnd": min(end, len(lines))})
                    used += len(encoded)
                    if truncated or used >= file_budget:
                        break
                successes.append({
                    **common,
                    "kind": "text",
                    "mime": "text/plain",
                    "segments": segments,
                    "lineCount": len(lines),
                    "truncated": truncated,
                })
                remaining -= used
                continue

            with open(path, "rb") as handle:
                raw = handle.read(file_budget)
            content, used = decode_prefix(raw)
            if content is None:
                failed(path_value, "binary_disallowed", "File is not valid UTF-8 text")
                continue
            successes.append({
                **common,
                "kind": "text",
                "mime": "text/plain",
                "segments": [{"content": content}],
                "lineCount": content.count("\n") + (0 if not content or content.endswith("\n") else 1),
                "truncated": stat.st_size > used,
            })
            remaining -= used
        except OSError:
            failed(path_value, "io_error", "File could not be read")

    response = {
        "id": request_id,
        "type": "read_files_result",
        "root": real_root,
        "files": successes,
        "failedFiles": failures,
        "bytesReturned": max_batch_bytes - remaining,
        "truncated": any(item.get("truncated") for item in successes) or any(item["code"] == "budget_exhausted" for item in failures),
    }
    with process_lock:
        cancellations.pop(request_id, None)
    write_message(response)


def handle(request: Any) -> None:
    if not isinstance(request, dict) or not isinstance(request.get("id"), int):
        return
    request_id = request["id"]
    request_type = request.get("type")
    if request_type == "initialize":
        if request.get("version") != PROTOCOL_VERSION:
            write_message({"id": request_id, "type": "error", "error": "unsupported_protocol"})
            return
        write_message({
            "id": request_id,
            "type": "initialize_result",
            "version": PROTOCOL_VERSION,
            "hostId": os.uname().nodename if hasattr(os, "uname") else "unknown",
            "platform": sys.platform,
            "python": list(sys.version_info[:3]),
        })
        return
    if request_type == "abort":
        abort_id = request.get("requestId")
        if isinstance(abort_id, int):
            with process_lock:
                process = running.get(abort_id)
            if process is not None:
                terminate_process(process)
            with process_lock:
                cancelled = cancellations.get(abort_id)
            if cancelled is not None:
                cancelled.set()
        write_message({"id": request_id, "type": "abort_result", "requestId": abort_id})
        return
    if request_type == "run":
        threading.Thread(target=execute, args=(request,), daemon=True).start()
        return
    if request_type == "read_files":
        cancelled = threading.Event()
        with process_lock:
            cancellations[request_id] = cancelled
        threading.Thread(target=read_files, args=(request, cancelled), daemon=True).start()
        return
    write_message({"id": request_id, "type": "error", "error": "unknown_request"})


def main() -> int:
    while True:
        header = read_exact(4)
        if header is None:
            break
        length = struct.unpack("<I", header)[0]
        if length == 0 or length > MAX_FRAME_BYTES:
            return 2
        payload = read_exact(length)
        if payload is None:
            break
        try:
            request = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return 2
        handle(request)

    with process_lock:
        processes = list(running.values())
        pending_reads = list(cancellations.values())
    for cancelled in pending_reads:
        cancelled.set()
    for process in processes:
        terminate_process(process)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
