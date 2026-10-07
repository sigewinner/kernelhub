"""CKP 适配器 SDK —— 写一个内核只需要这一个 import。

适配器作者只需要::

    from kernelhub.sdk import KernelApp, emit_progress, emit_artifact

    def convert(job, ctx):
        ...
        return [{"path": dst, "format": "jpg", "bytes": os.path.getsize(dst)}]

    if __name__ == "__main__":
        raise SystemExit(KernelApp("my-kernel", "1.0.0").run(convert))

SDK 负责把一切协议细节挡在外面：

* 解析 ``--ckp-job``（或回落 stdin）
* 强制 UTF-8 输出（Windows 控制台默认 GBK 会毁掉 NDJSON）
* **把 stdout 保护起来**：处理期间 ``sys.stdout`` 被重定向到 stderr，
  于是引擎/第三方库随手 ``print()`` 也不会污染事件流
* hello / progress / artifact / result / error 事件封装
* 异常自动翻译成带 CKP 错误码的 ``error`` 事件与正确退出码
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import sys
import time
import traceback
from typing import Any, Callable, Iterable, Mapping, Sequence

from kernelhub.protocol import (  # noqa: F401  (对外重新导出，方便适配器使用)
    CKP_VERSION,
    CkpError,
    canonical_format,
    format_of_path,
)

__all__ = [
    "CKP_VERSION",
    "CkpError",
    "KernelApp",
    "emit",
    "emit_log",
    "emit_progress",
    "emit_artifact",
    "emit_result",
    "emit_error",
    "load_job",
    "file_sha256",
    "guess_output_path",
    "ensure_parent",
    "canonical_format",
    "format_of_path",
    "probe_engine",
]

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_BADJOB = 2
EXIT_NODEP = 3
EXIT_NOINPUT = 4
EXIT_NOOUTPUT = 5

#: 保存真正的 stdout，SDK 的所有事件都写到这里
_STDOUT = sys.stdout


def _hard_utf8() -> None:
    """把 stdout/stderr 强制设为 UTF-8，避免中文与路径乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


_hard_utf8()


def emit(event: Mapping[str, Any]) -> None:
    """输出一个 NDJSON 事件（一行一个 JSON 对象）。"""
    line = json.dumps(dict(event), ensure_ascii=False)
    _STDOUT.write(line + "\n")
    _STDOUT.flush()


def emit_log(message: str, level: str = "info") -> None:
    emit({"type": "log", "level": level, "message": message})


def emit_progress(value: float | None = None, message: str = "",
                  current: float | None = None, total: float | None = None) -> None:
    evt: dict[str, Any] = {"type": "progress"}
    if value is not None:
        evt["value"] = max(0.0, min(1.0, float(value)))
    if current is not None:
        evt["current"] = current
    if total is not None:
        evt["total"] = total
    if message:
        evt["message"] = message
    emit(evt)


def emit_artifact(path: str, fmt: str = "", *, primary: bool = False,
                  meta: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """上报一个产物，返回补齐后的 output 字典（可直接塞进 result.outputs）。"""
    info: dict[str, Any] = {
        "path": os.path.abspath(path),
        "format": fmt or format_of_path(path),
    }
    try:
        info["bytes"] = os.path.getsize(path)
    except OSError:
        pass
    if meta:
        info.update(dict(meta))
    evt = {"type": "artifact", **info, "primary": bool(primary)}
    emit(evt)
    return info


def emit_result(job_id: str, outputs: Sequence[Mapping[str, Any]],
                metrics: Mapping[str, Any] | None = None,
                kernel_id: str = "", kernel_version: str = "") -> None:
    evt: dict[str, Any] = {
        "type": "result",
        "ok": True,
        "ckp": CKP_VERSION,
        "job_id": job_id,
        "outputs": [dict(o) for o in outputs],
    }
    if kernel_id:
        evt["kernel"] = {"id": kernel_id, "version": kernel_version}
    if metrics:
        evt["metrics"] = dict(metrics)
    emit(evt)


def emit_error(job_id: str, code: str, message: str, detail: str = "",
               retryable: bool | None = None) -> None:
    from kernelhub.protocol import ERROR_CODES

    evt = {
        "type": "error",
        "ok": False,
        "ckp": CKP_VERSION,
        "job_id": job_id,
        "code": code,
        "message": message,
    }
    if detail:
        evt["detail"] = detail
    evt["retryable"] = ERROR_CODES.get(code, False) if retryable is None else retryable
    emit(evt)


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #


def file_sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def ensure_parent(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)


def guess_output_path(job: Mapping[str, Any], ext: str, index: int = 0) -> str:
    """在 ``outputs`` 缺失或为空时，为产物推导一个输出路径。"""
    outputs = job.get("outputs") or []
    if outputs and index < len(outputs):
        return str(outputs[index]["path"])
    inputs = job.get("inputs") or []
    stem = "output"
    if inputs:
        stem = os.path.splitext(os.path.basename(str(inputs[0]["path"])))[0]
    workdir = job.get("workdir") or os.path.join(os.path.expanduser("~"), "kernelhub-out")
    ensure_parent(os.path.join(workdir, "x"))
    return os.path.join(workdir, f"{stem}.{ext.lstrip('.')}")


def probe_engine(importer: Callable[[], Any]) -> str:
    """探测引擎版本字符串；失败返回空串。"""
    try:
        return str(importer())
    except Exception:  # noqa: BLE001
        return ""


def load_job(argv: Sequence[str] | None = None) -> dict[str, Any]:
    """按协议读取 Job：优先 ``--ckp-job <path>``，否则读 stdin。"""
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--ckp-job", dest="ckp_job", default=None)
    namespace, _unknown = parser.parse_known_args(list(argv or []))

    if namespace.ckp_job:
        with open(namespace.ckp_job, "r", encoding="utf-8-sig") as fh:
            return json.load(fh)

    data = sys.stdin.read()
    if not data or not data.strip():
        raise CkpError("BAD_JOB", "未收到任务：既没有 --ckp-job，stdin 也为空")
    return json.loads(data)


# --------------------------------------------------------------------------- #
# 应用外壳
# --------------------------------------------------------------------------- #

Handler = Callable[[dict[str, Any], "KernelApp"], Sequence[Mapping[str, Any]] | None]


class KernelApp:
    """适配器外壳：处理生命周期、事件、异常与退出码。"""

    def __init__(self, kernel_id: str, version: str = "1.0.0",
                 engine: str = "", *, protocol_error_code: str = "INTERNAL") -> None:
        self.kernel_id = kernel_id
        self.version = version
        self.engine = engine
        self.protocol_error_code = protocol_error_code
        self.extra_metrics: dict[str, Any] = {}
        self._started = time.time()

    # -- 事件快捷方式 ------------------------------------------------------- #

    def log(self, message: str, level: str = "info") -> None:
        emit_log(message, level)

    def progress(self, value: float, message: str = "") -> None:
        emit_progress(value, message)

    def artifact(self, path: str, fmt: str = "", *, primary: bool = False,
                 meta: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return emit_artifact(path, fmt, primary=primary, meta=meta)

    # -- 运行 --------------------------------------------------------------- #

    @contextlib.contextmanager
    def _guard_stdout(self):
        """处理期间把 stdout 换成 stderr，防止引擎乱 print 破坏 NDJSON。"""
        real = _STDOUT
        try:
            sys.stdout = sys.stderr  # type: ignore[assignment]
            yield
        finally:
            sys.stdout = real  # type: ignore[assignment]

    def run(self, handler: Handler, argv: Sequence[str] | None = None) -> int:
        # hello 必须最先发，让宿主确认适配器活着
        emit({
            "type": "hello",
            "ckp": CKP_VERSION,
            "kernel": self.kernel_id,
            "version": self.version,
            "engine": self.engine,
            "pid": os.getpid(),
        })

        job: dict[str, Any] = {}
        try:
            job = load_job(argv if argv is not None else sys.argv[1:])
        except CkpError as exc:
            emit_error("", exc.code, exc.message, exc.detail, exc.retryable)
            return EXIT_BADJOB
        except (OSError, ValueError) as exc:
            emit_error("", "BAD_JOB", f"无法解析任务: {exc}", traceback.format_exc())
            return EXIT_BADJOB

        job_id = str(job.get("job_id", ""))
        try:
            with self._guard_stdout():
                outputs = handler(job, self)
        except CkpError as exc:
            emit_error(job_id, exc.code, exc.message, exc.detail, exc.retryable)
            return _exit_code_for(exc.code)
        except FileNotFoundError as exc:
            emit_error(job_id, "INPUT_NOT_FOUND", f"文件不存在: {exc}",
                       traceback.format_exc())
            return EXIT_NOINPUT
        except PermissionError as exc:
            emit_error(job_id, "OUTPUT_NOT_WRITABLE", f"路径不可写: {exc}",
                       traceback.format_exc())
            return EXIT_NOOUTPUT
        except ImportError as exc:
            emit_error(job_id, "DEPENDENCY_MISSING", f"依赖缺失: {exc}",
                       traceback.format_exc())
            return EXIT_NODEP
        except Exception as exc:  # noqa: BLE001
            emit_error(job_id, self.protocol_error_code,
                       f"{type(exc).__name__}: {exc}", traceback.format_exc())
            return EXIT_FAIL

        duration_ms = int((time.time() - self._started) * 1000)
        metrics: dict[str, Any] = {"duration_ms": duration_ms}
        if self.engine:
            metrics["engine"] = self.engine
        if self.extra_metrics:
            metrics.update(self.extra_metrics)
        emit_result(job_id, list(outputs or []), metrics,
                    kernel_id=self.kernel_id, kernel_version=self.version)
        return EXIT_OK


def _exit_code_for(code: str) -> int:
    return {
        "BAD_JOB": EXIT_BADJOB,
        "PROTOCOL_VERSION": EXIT_BADJOB,
        "DEPENDENCY_MISSING": EXIT_NODEP,
        "INPUT_NOT_FOUND": EXIT_NOINPUT,
        "INPUT_UNREADABLE": EXIT_NOINPUT,
        "OUTPUT_NOT_WRITABLE": EXIT_NOOUTPUT,
        "OUTPUT_EXISTS": EXIT_NOOUTPUT,
    }.get(code, EXIT_FAIL)
