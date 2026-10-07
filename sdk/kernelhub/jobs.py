"""任务编排：把「用户想转一个文件」翻译成「选内核 → 建 Job → 跑 → 校验」。

上层（CLI / GUI）只需要认识这一个模块。
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

from kernelhub import paths
from kernelhub.protocol import (
    CKP_VERSION,
    CkpError,
    InputRef,
    NoKernelError,
    OutputRef,
    build_job,
    canonical_format,
    format_of_path,
    new_job_id,
)
from kernelhub.registry import KernelEntry, Registry
from kernelhub.runner import JobOutcome, KernelRunner

#: 某些格式不写进扩展名（避免出现 a.jpeg）
EXT_OVERRIDE: dict[str, str] = {}


def extension_for(fmt: str) -> str:
    fmt = canonical_format(fmt)
    return EXT_OVERRIDE.get(fmt, fmt) or "bin"


def default_output_path(src: str, target_format: str, out_dir: str = "",
                        existing: Iterable[str] = ()) -> str:
    """为一次转换推导输出路径，并自动避免覆盖（加 ``-1``、``-2`` 后缀）。"""
    fmt = canonical_format(target_format)
    ext = extension_for(fmt)
    stem = os.path.splitext(os.path.basename(src))[0] or "output"
    directory = out_dir or os.path.dirname(os.path.abspath(src))
    paths.ensure_dir(directory)

    taken = {os.path.normcase(os.path.abspath(p)) for p in existing}
    candidate = os.path.join(directory, f"{stem}.{ext}")
    index = 1
    while os.path.normcase(os.path.abspath(candidate)) in taken or (
            os.path.exists(candidate) and os.path.normcase(os.path.abspath(candidate)) in taken):
        candidate = os.path.join(directory, f"{stem}-{index}.{ext}")
        index += 1
    return candidate


@dataclass
class ConvertRequest:
    """一次转换请求（上层填好它，Hub 负责执行）。"""

    sources: list[str]
    target_format: str = ""
    op: str = "convert"
    out_dir: str = ""
    out_path: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    kernel_id: str = ""
    timeout_ms: int = 0
    overwrite: bool = True

    def resolved_outputs(self) -> list[str]:
        if self.out_path:
            if len(self.sources) > 1 and not os.path.splitext(self.out_path)[1]:
                return [os.path.join(self.out_path,
                                     os.path.basename(default_output_path(
                                         s, self.target_format, self.out_path)))
                        for s in self.sources]
            return [self.out_path]
        taken: list[str] = []
        out: list[str] = []
        for src in self.sources:
            path = default_output_path(src, self.target_format, self.out_dir, taken)
            taken.append(path)
            out.append(path)
        return out


class Hub:
    """内核中枢：注册表 + 运行器 + 业务语义。"""

    def __init__(self, registry: Registry | None = None,
                 runner: KernelRunner | None = None) -> None:
        self.registry = registry or Registry()
        self.runner = runner or KernelRunner()

    # -- 发现 --------------------------------------------------------------- #

    def refresh(self) -> Registry:
        return self.registry.reload()

    # -- 计划 --------------------------------------------------------------- #

    def target_formats(self, src: str, op: str = "convert") -> list[str]:
        fmt = format_of_path(src)
        return self.registry.targets_for(op, fmt)

    def source_formats(self, target_format: str, op: str = "convert") -> list[str]:
        return self.registry.sources_for(op, target_format)

    def plan(self, req: ConvertRequest) -> tuple[KernelEntry, Any, list[str]]:
        """选定内核并算出输出路径。返回 ``(内核, 能力, 输出路径列表)``。"""
        if not req.sources:
            raise CkpError("BAD_JOB", "至少需要一个输入文件")
        missing = [s for s in req.sources if not os.path.isfile(s)]
        if missing:
            raise CkpError("INPUT_NOT_FOUND", f"输入文件不存在: {', '.join(missing)}")

        src_fmt = format_of_path(req.sources[0])
        dst_fmt = canonical_format(req.target_format)
        multi_in = len(req.sources) > 1

        entry, cap = self.registry.resolve(
            req.op, src_fmt, dst_fmt, kernel_id=req.kernel_id,
            multi_in=multi_in, multi_out=len(req.sources) > 1 and bool(req.out_dir))

        outputs = req.resolved_outputs()
        for out in outputs:
            paths.ensure_dir(os.path.dirname(out))
        return entry, cap, outputs

    # -- 执行 --------------------------------------------------------------- #

    def run_job(self, entry: KernelEntry, job: Mapping[str, Any], **kw: Any) -> JobOutcome:
        return self.runner.run(entry, job, **kw)

    def convert(self, req: ConvertRequest, **hooks: Any) -> JobOutcome:
        """执行一次转换。

        规划阶段的错误（找不到内核、输入缺失…）也会被收敛成 ``JobOutcome``，
        而不是抛异常 —— 这样 GUI 和批量流程都不用写 try/except。
        """
        try:
            entry, _cap, outputs = self.plan(req)
        except CkpError as exc:
            return JobOutcome(ok=False, job_id="", kernel_id=req.kernel_id,
                              error=exc.to_event() | {"synthetic": True},
                              duration_ms=0)

        params = dict(req.params or {})
        job = build_job(
            req.op,
            [InputRef.from_path(s) for s in req.sources],
            [OutputRef.from_path(o, req.target_format) for o in outputs],
            params,
            kernel=entry.id,
            workdir=os.path.dirname(outputs[0]) if outputs else "",
            timeout_ms=req.timeout_ms,
            context={"overwrite": req.overwrite, "source": "hub"},
        )
        hooks.pop("on_plan", None)
        return self.run_job(entry, job, **hooks)

    def convert_one(self, src: str, target_format: str = "", *, op: str = "convert",
                    out_dir: str = "", out_path: str = "", params: Mapping[str, Any] | None = None,
                    kernel_id: str = "", timeout_ms: int = 0, **hooks: Any) -> JobOutcome:
        req = ConvertRequest(sources=[src], target_format=target_format, op=op,
                             out_dir=out_dir, out_path=out_path,
                             params=dict(params or {}), kernel_id=kernel_id,
                             timeout_ms=timeout_ms)
        return self.convert(req, **hooks)

    def convert_many(self, sources: Sequence[str], target_format: str, *,
                     op: str = "convert", out_dir: str = "",
                     params: Mapping[str, Any] | None = None, kernel_id: str = "",
                     timeout_ms: int = 0,
                     on_result: Callable[[str, JobOutcome], None] | None = None,
                     cancel: threading.Event | None = None,
                     **hooks: Any) -> list[JobOutcome]:
        """逐个文件转换（每个文件一个独立任务，便于并行与细粒度进度）。"""
        results: list[JobOutcome] = []
        taken: list[str] = []
        for src in sources:
            if cancel is not None and cancel.is_set():
                break
            out = default_output_path(src, target_format, out_dir, taken)
            taken.append(out)
            req = ConvertRequest(sources=[src], target_format=target_format, op=op,
                                 out_path=out, params=dict(params or {}),
                                 kernel_id=kernel_id, timeout_ms=timeout_ms)
            try:
                outcome = self.convert(req, cancel=cancel, **hooks)
            except CkpError as exc:
                outcome = JobOutcome(ok=False, job_id="", kernel_id=kernel_id,
                                     error=exc.to_event() | {"code": exc.code,
                                                             "message": exc.message,
                                                             "retryable": exc.retryable})
            results.append(outcome)
            if on_result:
                on_result(src, outcome)
        return results

    # -- 自检 --------------------------------------------------------------- #

    def doctor(self) -> dict[str, Any]:
        """环境与协议自检，供 GUI/CLI 展示。"""
        import platform
        import sys

        info: dict[str, Any] = {
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "platform": platform.platform(),
            "protocol": CKP_VERSION,
            "paths": paths.describe_layout(),
            "registry": self.registry.summary(),
            "kernels": [],
        }
        for entry in self.registry.all_entries():
            info["kernels"].append({
                "id": entry.id,
                "name": entry.name,
                "status": entry.status,
                "detail": entry.detail,
                "engine_note": entry.engine_note,
                "capabilities": sum(len(c.from_) * len(c.to) for c in entry.manifest.capabilities),
                "ops": entry.manifest.ops(),
                "license": entry.manifest.license,
                "homepage": entry.manifest.homepage,
                "install_hint": entry.install_hint(),
            })
        return info
