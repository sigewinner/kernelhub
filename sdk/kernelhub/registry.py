"""内核注册表：发现 → 校验 → 探测 → 索引 → 选择。

宿主启动后只跟这个类打交道，它把「磁盘上有一堆插件目录」变成
「一张可查询的能力表」。
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from kernelhub import paths
from kernelhub.protocol import (
    STATUS_DEGRADED,
    STATUS_DISABLED,
    STATUS_INVALID,
    STATUS_READY,
    STATUS_UNAVAILABLE,
    STATUS_LABELS_ZH,
    Capability,
    CkpError,
    KernelManifest,
    NoKernelError,
    canonical_format,
    validate_manifest,
)

MANIFEST_NAME = "kernel.json"

SKIP_DIRS = {"__pycache__", "node_modules", ".git", ".venv", "venv"}


# --------------------------------------------------------------------------- #
# 条目
# --------------------------------------------------------------------------- #


@dataclass
class KernelEntry:
    """一个已发现的内核。"""

    manifest: KernelManifest
    directory: str
    manifest_path: str
    status: str = STATUS_UNAVAILABLE
    detail: str = ""
    engine_note: str = ""
    mtime: float = 0.0

    @property
    def id(self) -> str:
        return self.manifest.id

    @property
    def name(self) -> str:
        return self.manifest.name or self.manifest.id

    @property
    def usable(self) -> bool:
        return self.status == STATUS_READY

    @property
    def entry_path(self) -> str:
        return os.path.normpath(os.path.join(self.directory, self.manifest.runtime.entry))

    def install_hint(self) -> str:
        hook = (self.manifest.hooks or {}).get("install") or {}
        if hook.get("type") == "command" and hook.get("command"):
            args = " ".join(str(a) for a in (hook.get("args") or []))
            return f"{hook['command']} {args}".strip()
        if hook.get("description"):
            return str(hook["description"])
        return ""

    def to_public_dict(self) -> dict[str, Any]:
        data = self.manifest.to_public_dict()
        data.update({
            "status": self.status,
            "status_label": STATUS_LABELS_ZH.get(self.status, self.status),
            "detail": self.detail,
            "engine_note": self.engine_note,
            "directory": self.directory,
            "entry_path": self.entry_path,
            "install_hint": self.install_hint(),
        })
        return data


# --------------------------------------------------------------------------- #
# 探测
# --------------------------------------------------------------------------- #


def _probe_python_import(target: str) -> tuple[bool, str]:
    if not target:
        return True, ""
    try:
        spec = importlib.util.find_spec(target)
    except (ImportError, ValueError, AttributeError) as exc:
        return False, f"import 探测失败: {exc}"
    if spec is None:
        return False, f"Python 模块 '{target}' 未安装"
    version = ""
    try:
        mod = sys.modules.get(target)
        if mod is not None:
            version = str(getattr(mod, "__version__", "") or "")
    except Exception:  # noqa: BLE001
        version = ""
    return True, version


def _probe_command(target: str, args: Sequence[str], expect: str,
                   timeout: float = 8.0) -> tuple[bool, str]:
    exe = shutil.which(target)
    if not exe:
        # 允许 target 本身就是绝对路径
        if os.path.isfile(target) and os.access(target, os.X_OK):
            exe = target
        else:
            return False, f"未在 PATH 中找到命令 '{target}'"
    if not args and not expect:
        return True, exe
    try:
        proc = subprocess.run([exe, *args], capture_output=True, text=True,
                              timeout=timeout, errors="replace")
        out = (proc.stdout or "") + (proc.stderr or "")
        if expect and expect.lower() not in out.lower():
            return False, f"命令输出中未找到 {expect!r}"
        first = out.strip().splitlines()[0] if out.strip() else exe
        return True, first[:160]
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"命令探测失败: {exc}"


def probe_entry(entry: KernelEntry) -> tuple[bool, str, str]:
    """返回 ``(可用, 说明, 状态)``。"""
    manifest = entry.manifest
    probe = manifest.probe
    ptype = probe.type or "none"

    if ptype == "none":
        requires = manifest.runtime.requires
        if requires:
            missing = [r for r in requires if not _safe_find_spec(r)]
            if missing:
                return False, f"缺少 Python 依赖: {', '.join(missing)}", STATUS_DEGRADED
            return True, f"依赖就绪: {', '.join(requires)}", STATUS_READY
        return _check_entry_file(entry)

    if ptype == "python-import":
        ok, note = _probe_python_import(probe.target)
        if not ok:
            return False, note, STATUS_DEGRADED
        return True, note or f"模块 {probe.target} 就绪", _entry_status(entry)

    if ptype == "command":
        ok, note = _probe_command(probe.target, probe.args, probe.expect)
        if not ok:
            return False, note, STATUS_UNAVAILABLE
        return True, note, _entry_status(entry)

    if ptype == "ckp-executable":
        # 用与 CliBridge 完全相同的解析逻辑，保证「探测通过」== 「真能跑起来」
        from kernelhub import executables as exe_mod

        spec = ((manifest.raw.get("x-cli") or {}).get("executables") or {}).get(probe.target)
        try:
            path, source = exe_mod.resolve_executable(probe.target, spec, entry.directory)
        except CkpError as exc:
            detail = f"{exc.message}" + (f"（{exc.detail}）" if exc.detail else "")
            return False, detail, STATUS_UNAVAILABLE
        label = os.path.basename(path) if path else probe.target
        return True, f"{label} ← {source}", _entry_status(entry)

    if ptype == "file":
        target = probe.target
        if not os.path.isabs(target):
            target = os.path.join(entry.directory, target)
        if os.path.exists(target):
            return True, target, _entry_status(entry)
        return False, f"未找到文件: {target}", STATUS_UNAVAILABLE

    return True, "", _entry_status(entry)


def _safe_find_spec(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def _check_entry_file(entry: KernelEntry) -> tuple[bool, str, str]:
    rtype = entry.manifest.runtime.type
    if rtype == "builtin":
        return True, "宿主内置适配器", STATUS_READY
    path = entry.entry_path
    if not os.path.isfile(path):
        return False, f"适配器入口不存在: {path}", STATUS_INVALID
    return True, os.path.basename(path), STATUS_READY


def _entry_status(entry: KernelEntry) -> str:
    """探测已通过后，只再确认适配器入口文件是否存在。"""
    _ok, _note, status = _check_entry_file(entry)
    return status


# --------------------------------------------------------------------------- #
# 注册表
# --------------------------------------------------------------------------- #


class Registry:
    """内核注册表。"""

    def __init__(self, extra_dirs: Iterable[str] = ()) -> None:
        self.entries: dict[str, KernelEntry] = {}
        self.errors: list[str] = []
        self._extra_dirs = [os.path.abspath(d) for d in extra_dirs]
        self._config = paths.load_config()
        self._disabled: set[str] = set(self._config.get("disabled_kernels") or [])
        self._priority_override: dict[str, int] = dict(
            self._config.get("priority_overrides") or {})

    # -- 发现 --------------------------------------------------------------- #

    def discover(self) -> "Registry":
        """扫描所有搜索路径，重建注册表。"""
        self.entries.clear()
        self.errors.clear()
        search = list(self._extra_dirs) + paths.plugin_search_paths()

        seen_dirs: set[str] = set()
        for base in search:
            base = os.path.abspath(base)
            if not os.path.isdir(base):
                continue
            try:
                children = sorted(os.listdir(base))
            except OSError as exc:
                self.errors.append(f"无法读取插件目录 {base}: {exc}")
                continue
            for child in children:
                if child.startswith(".") or child in SKIP_DIRS or child.startswith("_"):
                    continue
                plugin_dir = os.path.join(base, child)
                if not os.path.isdir(plugin_dir):
                    continue
                norm = os.path.normcase(plugin_dir)
                if norm in seen_dirs:
                    continue
                seen_dirs.add(norm)
                entry = self._load(plugin_dir)
                if entry is not None:
                    self._register(entry)
        return self

    def _load(self, plugin_dir: str) -> KernelEntry | None:
        manifest_path = os.path.join(plugin_dir, MANIFEST_NAME)
        if not os.path.isfile(manifest_path):
            return None
        mtime = 0.0
        try:
            mtime = os.path.getmtime(manifest_path)
        except OSError:
            pass
        try:
            with open(manifest_path, "r", encoding="utf-8-sig") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            kid = os.path.basename(plugin_dir)
            broken = KernelManifest(id=f"invalid.{kid}", name=f"{kid}（清单损坏）",
                                    version="0.0.0")
            return KernelEntry(manifest=broken, directory=plugin_dir,
                               manifest_path=manifest_path, status=STATUS_INVALID,
                               detail=f"kernel.json 解析失败: {exc}", mtime=mtime)

        problems = validate_manifest(data)
        manifest = KernelManifest.from_dict(data)
        entry = KernelEntry(manifest=manifest, directory=plugin_dir,
                            manifest_path=manifest_path, mtime=mtime)
        if problems:
            entry.status = STATUS_INVALID
            entry.detail = "；".join(problems)
            return entry

        override = self._priority_override.get(manifest.id)
        if isinstance(override, int):
            manifest.priority = override

        usable, note, status = probe_entry(entry)
        entry.status = status
        entry.engine_note = note
        if not usable and not entry.detail:
            entry.detail = note

        if manifest.id in self._disabled:
            entry.status = STATUS_DISABLED
            entry.detail = "已被用户停用"

        return entry

    def _register(self, entry: KernelEntry) -> None:
        existing = self.entries.get(entry.id)
        if existing is not None:
            # 同 id 冲突：保留状态更"好"的那个，并记录冲突
            better = _status_rank(entry.status) < _status_rank(existing.status)
            self.errors.append(
                f"内核 id 冲突: {entry.id} —— {existing.directory} 与 {entry.directory}，"
                f"保留 {entry.directory if better else existing.directory}"
            )
            if better:
                self.entries[entry.id] = entry
            return
        self.entries[entry.id] = entry

    # -- 查询 --------------------------------------------------------------- #

    def reload(self) -> "Registry":
        self._config = paths.load_config()
        self._disabled = set(self._config.get("disabled_kernels") or [])
        self._priority_override = dict(self._config.get("priority_overrides") or {})
        return self.discover()

    def get(self, kernel_id: str) -> KernelEntry | None:
        return self.entries.get(kernel_id)

    def ready_entries(self) -> list[KernelEntry]:
        return [e for e in self.entries.values() if e.usable]

    def all_entries(self) -> list[KernelEntry]:
        return sorted(self.entries.values(), key=lambda e: e.id)

    def ops(self) -> list[str]:
        seen: list[str] = []
        for entry in self.ready_entries():
            for cap in entry.manifest.capabilities:
                if cap.op not in seen:
                    seen.append(cap.op)
        return sorted(seen)

    def input_formats(self, op: str) -> list[str]:
        out: set[str] = set()
        for entry in self.ready_entries():
            for cap in entry.manifest.capabilities:
                if cap.op == op:
                    out.update(f for f in cap.from_ if f != "*")
        return sorted(out)

    def output_formats(self, op: str) -> list[str]:
        out: set[str] = set()
        for entry in self.ready_entries():
            for cap in entry.manifest.capabilities:
                if cap.op == op:
                    out.update(f for f in cap.to if f != "*")
        return sorted(out)

    def targets_for(self, op: str, src_fmt: str) -> list[str]:
        """给定输入格式，能转出哪些格式（用于 GUI 联动）。"""
        src = canonical_format(src_fmt)
        out: set[str] = set()
        for entry in self.ready_entries():
            for cap in entry.manifest.capabilities:
                if cap.op != op or not cap.accepts_input(src):
                    continue
                out.update(f for f in cap.to if f != "*")
        return sorted(out)

    def sources_for(self, op: str, dst_fmt: str) -> list[str]:
        dst = canonical_format(dst_fmt)
        out: set[str] = set()
        for entry in self.ready_entries():
            for cap in entry.manifest.capabilities:
                if cap.op != op or not cap.accepts_output(dst):
                    continue
                out.update(f for f in cap.from_ if f != "*")
        return sorted(out)

    # -- 选择 --------------------------------------------------------------- #

    def candidates(self, op: str, src_fmt: str, dst_fmt: str,
                   *, multi_in: bool = False, multi_out: bool = False,
                   ) -> list[tuple[KernelEntry, Capability]]:
        src = canonical_format(src_fmt)
        dst = canonical_format(dst_fmt)
        hits: list[tuple[KernelEntry, Capability]] = []
        for entry in self.ready_entries():
            for cap in entry.manifest.capabilities:
                if cap.op != op:
                    continue
                if not cap.accepts_input(src) or not cap.accepts_output(dst):
                    continue
                if multi_in and not cap.multi_in:
                    continue
                if multi_out and not cap.multi_out:
                    continue
                hits.append((entry, cap))

        hits.sort(key=lambda pair: (
            -pair[1].quality,
            -pair[0].manifest.priority,
            -pair[1].specificity(src, dst),
            pair[0].id,
        ))
        return hits

    def resolve(self, op: str, src_fmt: str, dst_fmt: str, *,
                kernel_id: str = "", multi_in: bool = False, multi_out: bool = False,
                ) -> tuple[KernelEntry, Capability]:
        """按协议第 10 节的选择算法挑一个内核。"""
        if kernel_id:
            entry = self.entries.get(kernel_id)
            if entry is None:
                raise NoKernelError(f"指定的内核不存在: {kernel_id}")
            if not entry.usable:
                raise NoKernelError(
                    f"内核 {kernel_id} 当前不可用（{STATUS_LABELS_ZH.get(entry.status)}）："
                    f"{entry.detail}")
            caps = entry.manifest.find_capabilities(op, src_fmt, dst_fmt)
            if not caps:
                raise NoKernelError(
                    f"内核 {kernel_id} 不支持 {src_fmt or '*'} → {dst_fmt or '*'}（{op}）")
            caps.sort(key=lambda c: (-c.quality, -c.specificity(src_fmt, dst_fmt)))
            return entry, caps[0]

        hits = self.candidates(op, src_fmt, dst_fmt, multi_in=multi_in,
                               multi_out=multi_out)
        if hits:
            return hits[0]

        raise NoKernelError(
            self._explain_miss(op, src_fmt, dst_fmt, multi_in, multi_out),
            detail=json.dumps(self._near_misses(op, src_fmt, dst_fmt),
                              ensure_ascii=False, indent=2),
        )

    def _near_misses(self, op: str, src: str, dst: str,
                     limit: int = 6) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for entry in self.ready_entries():
            in_hit = entry.manifest.find_capabilities(op, src, "*")
            out_hit = entry.manifest.find_capabilities(op, "*", dst)
            if in_hit or out_hit:
                rows.append({
                    "kernel": entry.id,
                    "name": entry.name,
                    "status": entry.status,
                    "can_read_input": bool(in_hit),
                    "can_write_output": bool(out_hit),
                    "ops": entry.manifest.ops(),
                })
        return rows[:limit]

    def _explain_miss(self, op: str, src: str, dst: str,
                      multi_in: bool, multi_out: bool) -> str:
        ready = self.ready_entries()
        if not ready:
            pending = [e for e in self.all_entries() if e.status != STATUS_READY]
            hint = "；".join(f"{e.id}({STATUS_LABELS_ZH.get(e.status)})" for e in pending[:5])
            return ("目前没有任何可用内核。"
                    + (f" 已发现但不可用：{hint}" if hint else ""))
        ops = sorted({c.op for e in ready for c in e.manifest.capabilities})
        msg = f"没有内核能完成 {src or '*'} → {dst or '*'}（操作 {op}）。可用操作：{', '.join(ops)}"
        if multi_in:
            msg += "（该任务需要多输入支持）"
        if multi_out:
            msg += "（该任务需要多输出支持）"
        return msg

    # -- 启停 --------------------------------------------------------------- #

    def set_enabled(self, kernel_id: str, enabled: bool) -> bool:
        cfg = paths.load_config()
        disabled = set(cfg.get("disabled_kernels") or [])
        if enabled:
            disabled.discard(kernel_id)
        else:
            disabled.add(kernel_id)
        cfg["disabled_kernels"] = sorted(disabled)
        if not paths.save_config(cfg):
            return False
        self._disabled = disabled
        entry = self.entries.get(kernel_id)
        if entry is not None:
            if enabled:
                _usable, note, status = probe_entry(entry)
                entry.status = status
                entry.engine_note = note
                entry.detail = "" if status == STATUS_READY else note
            else:
                entry.status = STATUS_DISABLED
                entry.detail = "已被用户停用"
        return True

    def set_priority(self, kernel_id: str, priority: int) -> bool:
        cfg = paths.load_config()
        overrides = dict(cfg.get("priority_overrides") or {})
        overrides[kernel_id] = int(priority)
        cfg["priority_overrides"] = overrides
        if not paths.save_config(cfg):
            return False
        entry = self.entries.get(kernel_id)
        if entry is not None:
            entry.manifest.priority = int(priority)
        return True

    # -- 导出 --------------------------------------------------------------- #

    def public_list(self) -> list[dict[str, Any]]:
        return [e.to_public_dict() for e in self.all_entries()]

    def summary(self) -> dict[str, Any]:
        by_status: dict[str, int] = {}
        for entry in self.entries.values():
            by_status[entry.status] = by_status.get(entry.status, 0) + 1
        return {
            "total": len(self.entries),
            "ready": len(self.ready_entries()),
            "by_status": by_status,
            "ops": self.ops(),
            "search_paths": paths.plugin_search_paths(),
            "errors": list(self.errors),
        }


def _status_rank(status: str) -> int:
    return {
        STATUS_READY: 0,
        STATUS_DEGRADED: 1,
        STATUS_UNAVAILABLE: 2,
        STATUS_INVALID: 3,
        STATUS_DISABLED: 4,
    }.get(status, 9)
