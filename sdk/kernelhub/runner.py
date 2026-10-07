"""运行器：把 Job 喂给内核，把 NDJSON 事件流收回来。

这是 CKP 协议在宿主侧的「进程级契约」实现（协议第 9 节）：

* 按 ``runtime.type`` 展开 argv，末尾追加 ``--ckp-job <path>``
* 注入 CKP_* 环境变量与 PYTHONPATH / PYTHONUTF8
* 后台线程逐行读 stdout（避免管道阻塞死锁）与 stderr
* 单线程解析 NDJSON，容忍非 JSON 行、容忍重复终态
* 超时 → 杀进程树 → 合成 TIMEOUT 错误事件
* 无终态即退出 → 合成 PROTOCOL_NO_TERMINAL_EVENT
* 产物二次校验（存在、非空、可读）
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from kernelhub import paths
from kernelhub.protocol import (
    CKP_VERSION,
    ERROR_CODES,
    TERMINAL_EVENTS,
    CkpError,
    parse_event_line,
)

# Windows 进程标志
_CREATE_NO_WINDOW = 0x08000000
_CREATE_NEW_PROCESS_GROUP = 0x00000200

RUN_DIR = os.path.join(paths.CACHE_DIR, "runs")

EventHook = Callable[[dict[str, Any]], None]
LogHook = Callable[[str, str], None]
ProgressHook = Callable[[float, str], None]


@dataclass
class JobOutcome:
    """一次内核调用的完整结果。"""

    ok: bool
    job_id: str
    kernel_id: str
    exit_code: int = 0
    duration_ms: int = 0
    outputs: list[dict[str, Any]] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    logs: list[tuple[str, str]] = field(default_factory=list)
    error: dict[str, Any] | None = None
    stderr: str = ""
    stdout_raw: str = ""
    command: list[str] = field(default_factory=list)
    job_path: str = ""

    @property
    def code(self) -> str:
        return str((self.error or {}).get("code", "")) if not self.ok else ""

    @property
    def message(self) -> str:
        if self.ok:
            return "成功"
        return str((self.error or {}).get("message", "未知错误"))

    def primary_output(self) -> dict[str, Any] | None:
        for art in self.artifacts:
            if art.get("primary"):
                return art
        return self.outputs[0] if self.outputs else (self.artifacts[0] if self.artifacts else None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "job_id": self.job_id,
            "kernel": self.kernel_id,
            "exit_code": self.exit_code,
            "duration_ms": self.duration_ms,
            "outputs": self.outputs,
            "artifacts": self.artifacts,
            "error": self.error,
            "code": self.code,
            "message": self.message,
            "stderr": self.stderr[-4000:],
            "command": self.command,
        }


# --------------------------------------------------------------------------- #
# 运行器
# --------------------------------------------------------------------------- #


class KernelRunner:
    """把内核清单变成可执行的子进程调用。"""

    def __init__(self, default_timeout_ms: int = 300_000,
                 max_timeout_ms: int = 1_800_000) -> None:
        self.default_timeout_ms = default_timeout_ms
        self.max_timeout_ms = max_timeout_ms

    # -- argv / env --------------------------------------------------------- #

    def build_command(self, entry: Any, job_path: str) -> list[str]:
        manifest = entry.manifest
        runtime = manifest.runtime
        extra = [str(a) for a in runtime.args]
        tail = ["--ckp-job", job_path]

        if runtime.type == "python":
            python = paths.python_executable()
            if runtime.python and runtime.python not in ("auto", "vendor"):
                python = runtime.python
            return [python, entry.entry_path, *extra, *tail]

        if runtime.type == "builtin":
            python = paths.python_executable()
            return [python, "-m", f"kernelhub.builtins.{runtime.entry}", *extra, *tail]

        if runtime.type == "node":
            return ["node", entry.entry_path, *extra, *tail]

        if runtime.type == "powershell":
            exe = os.environ.get("CKP_POWERSHELL", "powershell.exe")
            return [exe, "-NoProfile", "-NonInteractive",
                    "-ExecutionPolicy", "Bypass", "-File", entry.entry_path,
                    *extra, *tail]

        # exec
        return [entry.entry_path, *extra, *tail]

    def build_env(self, entry: Any, job: Mapping[str, Any]) -> dict[str, str]:
        env = dict(os.environ)
        manifest = entry.manifest

        for key in ("PYTHONPATH", "PYTHONIOENCODING", "PYTHONUTF8"):
            pass

        python_path_parts = [paths.VENDOR_DIR, paths.PROJECT_ROOT]
        existing = env.get("PYTHONPATH", "")
        if existing:
            python_path_parts.append(existing)
        env["PYTHONPATH"] = os.pathsep.join(p for p in python_path_parts if p)

        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"

        env["CKP"] = CKP_VERSION
        env["CKP_KERNEL_ID"] = manifest.id
        env["CKP_JOB_ID"] = str(job.get("job_id", ""))
        env["CKP_PLUGIN_DIR"] = entry.directory
        env["CKP_PROJECT_ROOT"] = paths.PROJECT_ROOT
        env["CKP_VENDOR"] = paths.VENDOR_DIR

        for key, value in (manifest.runtime.env or {}).items():
            env[str(key)] = os.path.expandvars(str(value))

        return env

    def workdir_for(self, entry: Any) -> str:
        cwd = entry.manifest.runtime.cwd
        if cwd:
            return cwd if os.path.isabs(cwd) else os.path.join(entry.directory, cwd)
        return entry.directory

    # -- Job 落盘 ----------------------------------------------------------- #

    def write_job(self, job: Mapping[str, Any]) -> str:
        """把 Job 写到项目内 ``.cache/runs/``，避免沙箱临时目录的坑。"""
        paths.ensure_dir(RUN_DIR)
        stamp = f"{int(time.time() * 1000)}-{os.getpid()}-{threading.get_ident() % 10000}"
        path = os.path.join(RUN_DIR, f"job-{stamp}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(dict(job), fh, ensure_ascii=False, indent=2)
        return path

    # -- 主流程 ------------------------------------------------------------- #

    def run(
        self,
        entry: Any,
        job: Mapping[str, Any],
        *,
        timeout_ms: int | None = None,
        on_event: EventHook | None = None,
        on_log: LogHook | None = None,
        on_progress: ProgressHook | None = None,
        cancel: threading.Event | None = None,
    ) -> JobOutcome:
        job_id = str(job.get("job_id", ""))
        kernel_id = entry.id
        started = time.time()

        job_path = self.write_job(job)
        command = self.build_command(entry, job_path)
        env = self.build_env(entry, job)
        cwd = self.workdir_for(entry)

        limit = int(timeout_ms or (job.get("limits", {}) or {}).get("timeout_ms", 0)
                    or self.default_timeout_ms)
        limit = max(1000, min(limit, self.max_timeout_ms))

        popen_kwargs: dict[str, Any] = {
            "cwd": cwd if os.path.isdir(cwd) else None,
            "env": env,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "bufsize": 1,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = _CREATE_NO_WINDOW | _CREATE_NEW_PROCESS_GROUP

        outcome = JobOutcome(ok=False, job_id=job_id, kernel_id=kernel_id,
                             command=command, job_path=job_path)

        try:
            proc = subprocess.Popen(command, **popen_kwargs)  # noqa: S603
        except FileNotFoundError as exc:
            outcome.error = _synthetic("DEPENDENCY_MISSING",
                                       f"无法启动内核进程: {exc}", str(exc))
            outcome.duration_ms = int((time.time() - started) * 1000)
            return outcome
        except OSError as exc:
            outcome.error = _synthetic("INTERNAL", f"启动失败: {exc}", str(exc))
            outcome.duration_ms = int((time.time() - started) * 1000)
            return outcome

        out_q: "queue.Queue[str | None]" = queue.Queue()
        err_lines: list[str] = []

        def _pump_stdout() -> None:
            try:
                assert proc.stdout is not None
                for line in proc.stdout:
                    out_q.put(line)
            except Exception:  # noqa: BLE001
                pass
            finally:
                out_q.put(None)

        def _pump_stderr() -> None:
            try:
                assert proc.stderr is not None
                for line in proc.stderr:
                    err_lines.append(line)
            except Exception:  # noqa: BLE001
                pass

        t_out = threading.Thread(target=_pump_stdout, name=f"ckp-out-{kernel_id}", daemon=True)
        t_err = threading.Thread(target=_pump_stderr, name=f"ckp-err-{kernel_id}", daemon=True)
        t_out.start()
        t_err.start()

        terminal: dict[str, Any] | None = None
        raw_lines: list[str] = []
        cancelled = False
        deadline = started + limit / 1000.0

        while True:
            if cancel is not None and cancel.is_set():
                cancelled = True
                _kill_tree(proc)
                break
            remaining = deadline - time.time()
            if remaining <= 0:
                _kill_tree(proc)
                break
            try:
                line = out_q.get(timeout=min(0.2, max(0.01, remaining)))
            except queue.Empty:
                if proc.poll() is not None and out_q.empty():
                    break
                continue
            if line is None:
                break

            raw_lines.append(line)
            event = parse_event_line(line)
            if event is None:
                # 非 JSON 行：按日志处理，绝不中断任务
                text = line.rstrip("\r\n")
                if text.strip():
                    outcome.logs.append(("debug", text))
                    if on_log:
                        on_log(text, "debug")
                continue

            outcome.events.append(event)
            etype = str(event.get("type", ""))

            if etype not in TERMINAL_EVENTS:
                if etype == "log":
                    outcome.logs.append(
                        (str(event.get("level", "info")), str(event.get("message", ""))))
                    if on_log:
                        on_log(str(event.get("message", "")), str(event.get("level", "info")))
                elif etype == "progress":
                    if on_progress:
                        value = event.get("value")
                        if value is None and event.get("total"):
                            try:
                                value = float(event["current"]) / float(event["total"])
                            except (TypeError, ValueError, ZeroDivisionError):
                                value = None
                        on_progress(float(value or 0.0), str(event.get("message", "")))
                elif etype == "artifact":
                    outcome.artifacts.append(dict(event))
                if on_event:
                    on_event(event)
                continue

            # 终态：只认第一个
            if terminal is None:
                terminal = dict(event)
                if on_event:
                    on_event(event)
            if etype == "result":
                break

        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass

        t_out.join(timeout=2)
        t_err.join(timeout=2)

        outcome.exit_code = proc.returncode if proc.returncode is not None else -1
        outcome.stderr = "".join(err_lines)
        outcome.stdout_raw = "".join(raw_lines)
        outcome.duration_ms = int((time.time() - started) * 1000)

        # ---- 终态判定 ---------------------------------------------------- #
        if cancelled:
            outcome.error = _synthetic("CANCELLED", "任务已被取消")
        elif terminal is None:
            if time.time() >= deadline and proc.returncode is not None:
                outcome.error = _synthetic(
                    "TIMEOUT", f"任务超时（>{limit} ms）",
                    outcome.stderr[-2000:])
            else:
                outcome.error = _synthetic(
                    "PROTOCOL_NO_TERMINAL_EVENT",
                    f"适配器退出（code={outcome.exit_code}）但未返回终态事件",
                    outcome.stderr[-2000:])
        elif str(terminal.get("type")) == "error":
            outcome.error = {
                "code": str(terminal.get("code", "INTERNAL")),
                "message": str(terminal.get("message", "内核报错")),
                "detail": str(terminal.get("detail", "")) or outcome.stderr[-2000:],
                "retryable": bool(terminal.get("retryable",
                                               ERROR_CODES.get(str(terminal.get("code")), False))),
            }
        else:
            outputs = list(terminal.get("outputs") or [])
            if not outputs and outcome.artifacts:
                outputs = [{k: v for k, v in a.items() if k != "type"} for a in outcome.artifacts]
            missing = [o for o in outputs
                       if not o.get("path") or not os.path.isfile(str(o.get("path")))]
            if missing:
                names = ", ".join(str(o.get("path", "?")) for o in missing)
                outcome.error = _synthetic(
                    "ARTIFACT_MISSING", f"内核声称产出但文件不存在: {names}",
                    outcome.stderr[-2000:])
            else:
                outcome.ok = True
                outcome.outputs = outputs

        if not outcome.ok and terminal and str(terminal.get("type")) == "result" and outcome.error:
            # 结果事件存在但产物校验失败：保留事件供 GUI 展示
            outcome.events.append(outcome.error)

        return outcome


# --------------------------------------------------------------------------- #
# 辅助
# --------------------------------------------------------------------------- #


def _synthetic(code: str, message: str, detail: str = "") -> dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "detail": detail,
        "retryable": ERROR_CODES.get(code, False),
        "synthetic": True,
    }


def _kill_tree(proc: subprocess.Popen) -> None:
    """尽力杀死整个进程树（Windows 上 subprocess 只杀直接子进程）。"""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=15,
                           creationflags=_CREATE_NO_WINDOW)
            return
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass
