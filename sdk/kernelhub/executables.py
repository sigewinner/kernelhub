"""可执行文件解析 —— CKP ``x-cli.executables`` 的公共实现。

命令行内核（ImageMagick、FFmpeg、Pandoc…）的可执行文件可能在很多地方：

* 用户用环境变量指过去（``CKP_EXE_FFMPEG``）
* 随 Python wheel 一起分发（``imageio_ffmpeg.get_ffmpeg_exe()``）
* 被 KernelHub 下载到项目内（``kernels/ffmpeg/bin/ffmpeg.exe``）
* 就在系统 PATH 上

注册表的 ``ckp-executable`` 探测与 CliBridge 的 ``{exe:名字}`` 占位符共用本模块，
保证「探测说可用」和「真的能跑起来」永远一致。
"""

from __future__ import annotations

import glob as globmod
import importlib
import os
import shutil
from typing import Any, Mapping

from kernelhub import paths
from kernelhub.protocol import CkpError

#: 默认解析顺序；可用 spec 里的 ``prefer`` 重排
DEFAULT_PREFER = ("env", "python", "bundled", "absolute", "path")

_SOURCES_HELP = {
    "env": "环境变量",
    "python": "Python 模块函数",
    "bundled": "项目内相对路径",
    "absolute": "绝对路径",
    "path": "系统 PATH",
}


def env_var_for(name: str) -> str:
    return "CKP_EXE_" + name.upper().replace("-", "_").replace(".", "_")


def resolve_executable(name: str, spec: Any,
                       plugin_dir: str = "") -> tuple[str, str]:
    """解析可执行文件。

    返回 ``(绝对路径, 来源说明)``；失败抛 :class:`CkpError`（``DEPENDENCY_MISSING``）。
    """
    if spec is None:
        found = shutil.which(name)
        if found:
            return found, f"PATH: {found}"
        if os.path.isabs(name) and os.path.isfile(name):
            return name, f"绝对路径: {name}"
        raise CkpError("DEPENDENCY_MISSING", f"未找到可执行文件 '{name}'")

    if isinstance(spec, str):
        spec = {"candidates": [spec]}
    if not isinstance(spec, Mapping):
        raise CkpError("BAD_JOB", f"executables.{name} 必须是对象或字符串")

    prefer = list(spec.get("prefer") or DEFAULT_PREFER)
    attempts: list[str] = []

    for source in prefer:
        if source == "env":
            key = env_var_for(name)
            value = os.environ.get(key, "").strip()
            if value:
                if os.path.isfile(value):
                    return value, f"环境变量 {key}"
                attempts.append(f"环境变量 {key}={value}（文件不存在）")
            else:
                attempts.append(f"环境变量 {key}（未设置）")

        elif source == "python":
            target = str(spec.get("python") or "")
            if not target:
                continue
            if ":" not in target:
                attempts.append(f"python:{target}（缺少 '模块:函数' 形式）")
                continue
            module_name, _, func_name = target.partition(":")
            try:
                module = importlib.import_module(module_name)
                func = getattr(module, func_name)
                path = str(func() or "")
                if path and os.path.isfile(path):
                    return path, f"Python {target}"
                attempts.append(f"python:{target} -> {path or '空路径'}")
            except Exception as exc:  # noqa: BLE001
                attempts.append(f"python:{target}（{type(exc).__name__}: {exc}）")

        elif source == "bundled":
            for pattern in (spec.get("bundled") or []):
                base = pattern if os.path.isabs(pattern) else os.path.join(
                    paths.PROJECT_ROOT, pattern)
                hits = [h for h in sorted(globmod.glob(base)) if os.path.isfile(h)]
                if hits:
                    return hits[0], f"项目内 {os.path.relpath(hits[0], paths.PROJECT_ROOT)}"
                attempts.append(f"bundled:{pattern}")

        elif source == "absolute":
            for candidate in (spec.get("absolute") or []):
                if os.path.isfile(candidate):
                    return candidate, f"绝对路径 {candidate}"
                attempts.append(f"absolute:{candidate}")

        elif source == "path":
            candidates = list(spec.get("candidates") or [name])
            for candidate in candidates:
                found = shutil.which(candidate)
                if found:
                    return found, f"PATH: {found}"
            attempts.append("PATH 中未找到 " + "、".join(candidates))

    raise CkpError(
        "DEPENDENCY_MISSING",
        f"找不到可执行文件 '{name}'",
        "已尝试 → " + "；".join(attempts) if attempts else "未配置 executables",
    )


def describe_spec(spec: Any) -> str:
    """给 GUI/文档用的一句话说明：这个内核靠什么找到引擎。"""
    if spec is None:
        return "系统 PATH"
    if isinstance(spec, str):
        return f"PATH: {spec}"
    parts: list[str] = []
    if spec.get("candidates"):
        parts.append("PATH: " + "/".join(str(c) for c in spec["candidates"]))
    if spec.get("python"):
        parts.append(f"Python: {spec['python']}")
    if spec.get("bundled"):
        parts.append("项目内: " + ", ".join(str(b) for b in spec["bundled"]))
    if spec.get("absolute"):
        parts.append("绝对路径: " + ", ".join(str(a) for a in spec["absolute"]))
    env_name = env_var_for("NAME")
    return ("；".join(parts) or "未配置") + f"（可用环境变量覆盖）"
