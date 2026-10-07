"""CKP 1.0 协议实现：常量、格式归一化、清单/任务校验。

本模块是协议的**唯一权威实现**，宿主与适配器 SDK 都从这里取常量与校验逻辑。
纯标准库，无第三方依赖，可被任意 Python 环境导入。
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, MutableMapping, Sequence

# --------------------------------------------------------------------------- #
# 版本
# --------------------------------------------------------------------------- #

CKP_VERSION = "1.0"
CKP_VERSION_MAJOR = 1
CKP_VERSION_MINOR = 0

# --------------------------------------------------------------------------- #
# 格式别名
# --------------------------------------------------------------------------- #

FORMAT_ALIASES: dict[str, str] = {
    "jpeg": "jpg", "jpe": "jpg", "jfif": "jpg", "jfi": "jpg",
    "tiff": "tif", "dib": "bmp",
    "htm": "html", "xhtml": "html",
    "yml": "yaml",
    "md": "markdown", "mdown": "markdown", "mkd": "markdown",
    "txt": "text", "log": "text",
    "mpg": "mpeg", "m4v": "mp4", "mka": "mkv",
    "wave": "wav", "aif": "aiff",
    "heic": "heif", "heics": "heif",
    "yuv": "raw",
    "ps": "postscript", "eps": "postscript",
}

#: 反向索引：规范名 -> 所有可接受别名（含自身）
FORMAT_FAMILY: dict[str, tuple[str, ...]] = {}
for _alias, _canon in FORMAT_ALIASES.items():
    FORMAT_FAMILY.setdefault(_canon, ())
for _alias, _canon in list(FORMAT_ALIASES.items()):
    FORMAT_FAMILY[_canon] = tuple(sorted({_canon, *(_a for _a, _c in FORMAT_ALIASES.items() if _c == _canon)}))


def canonical_format(name: str | None) -> str:
    """把格式名归一化为规范标签：小写、去掉前导点、展开别名。"""
    if not name:
        return ""
    fmt = str(name).strip().lower().lstrip(".")
    if not fmt:
        return ""
    return FORMAT_ALIASES.get(fmt, fmt)


def format_of_path(path: str) -> str:
    """从路径推断格式标签。"""
    _, ext = os.path.splitext(path or "")
    return canonical_format(ext)


def format_candidates(name: str) -> set[str]:
    """返回可与 ``name`` 匹配的所有标签（规范名 + 别名）。"""
    canon = canonical_format(name)
    if not canon:
        return set()
    out = {canon, *FORMAT_FAMILY.get(canon, ())}
    out.update(a for a, c in FORMAT_ALIASES.items() if c == canon)
    return out


def formats_match(declared: str, actual: str) -> bool:
    """``declared``（内核声明的标签）是否覆盖 ``actual``（实际格式）。"""
    if declared == "*":
        return True
    return bool(format_candidates(declared) & format_candidates(actual))


# --------------------------------------------------------------------------- #
# 参数
# --------------------------------------------------------------------------- #

PARAM_TYPES = ("int", "float", "bool", "string", "enum", "path", "color")

PARAM_DEFAULTS: dict[str, Any] = {
    "int": 0, "float": 0.0, "bool": False, "string": "",
    "enum": None, "path": "", "color": "#000000",
}


@dataclass
class ParamSpec:
    """一条参数声明，用于自动生成 GUI 控件。"""

    id: str
    type: str = "string"
    label: str = ""
    description: str = ""
    default: Any = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    enum: list[dict[str, Any]] = field(default_factory=list)
    advanced: bool = False
    required: bool = False
    applies_to: list[str] = field(default_factory=list)
    when: dict[str, list[str]] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ParamSpec":
        return cls(
            id=str(data.get("id", "")),
            type=str(data.get("type", "string")),
            label=str(data.get("label") or data.get("id") or ""),
            description=str(data.get("description", "")),
            default=data.get("default"),
            min=data.get("min"),
            max=data.get("max"),
            step=data.get("step"),
            enum=list(data.get("enum") or []),
            advanced=bool(data.get("advanced", False)),
            required=bool(data.get("required", False)),
            applies_to=[str(x) for x in (data.get("applies_to") or [])],
            when={k: [str(i) for i in v] for k, v in (data.get("when") or {}).items()},
            raw=dict(data),
        )

    def effective_default(self) -> Any:
        if self.default is not None:
            return self.default
        if self.type == "enum" and self.enum:
            return self.enum[0].get("value")
        return PARAM_DEFAULTS.get(self.type)

    def visible_for(self, op: str, src_fmt: str, dst_fmt: str) -> bool:
        """按 ``applies_to`` / ``when`` 判断该参数在当前场景是否应显示。"""
        if self.applies_to and op not in self.applies_to:
            return False
        if self.when:
            ops = self.when.get("op")
            if ops and op not in ops:
                return False
            srcs = self.when.get("from")
            if srcs and not any(formats_match(s, src_fmt) for s in srcs):
                return False
            dsts = self.when.get("to")
            if dsts and not any(formats_match(d, dst_fmt) for d in dsts):
                return False
        return True

    def to_dict(self) -> dict[str, Any]:
        return dict(self.raw) if self.raw else {"id": self.id, "type": self.type}


def merge_params(*groups: Iterable[ParamSpec]) -> list[ParamSpec]:
    """按 ``id`` 合并多组参数；后面的组覆盖前面的（能力级 > 顶层级）。"""
    merged: dict[str, ParamSpec] = {}
    order: list[str] = []
    for group in groups:
        for spec in group:
            if spec.id not in merged:
                order.append(spec.id)
            merged[spec.id] = spec
    return [merged[i] for i in order]


# --------------------------------------------------------------------------- #
# 能力
# --------------------------------------------------------------------------- #


@dataclass
class Capability:
    """一条「from -> to」的可执行能力声明。"""

    op: str
    from_: list[str] = field(default_factory=list)
    to: list[str] = field(default_factory=list)
    id: str = ""
    multi_in: bool = False
    multi_out: bool = False
    label: str = ""
    quality: int = 0
    params: list[ParamSpec] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.from_ = [canonical_format(f) or str(f).lower() for f in self.from_]
        self.to = [canonical_format(f) or str(f).lower() for f in self.to]
        if not self.id:
            self.id = f"{self.op}:{'+'.join(self.from_) or '*'}-{'+'.join(self.to) or '*'}"

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Capability":
        return cls(
            op=str(data.get("op", "")),
            from_=[str(x) for x in (data.get("from") or [])],
            to=[str(x) for x in (data.get("to") or [])],
            id=str(data.get("id", "")),
            multi_in=bool(data.get("multi_in", False)),
            multi_out=bool(data.get("multi_out", False)),
            label=str(data.get("label", "")),
            quality=int(data.get("quality", 0) or 0),
            params=[ParamSpec.from_dict(p) for p in (data.get("params") or [])],
            raw=dict(data),
        )

    def accepts_input(self, fmt: str) -> bool:
        return any(formats_match(d, fmt) for d in self.from_)

    def accepts_output(self, fmt: str) -> bool:
        return any(formats_match(d, fmt) for d in self.to)

    def specificity(self, src_fmt: str, dst_fmt: str) -> int:
        """匹配精确度：非通配 > 通配。"""
        score = 0
        if not any(d == "*" for d in self.from_) and src_fmt:
            score += 1
        if not any(d == "*" for d in self.to) and dst_fmt:
            score += 1
        return score

    def to_dict(self) -> dict[str, Any]:
        out = dict(self.raw)
        out.update({"op": self.op, "from": list(self.from_), "to": list(self.to), "id": self.id})
        return out


# --------------------------------------------------------------------------- #
# 清单
# --------------------------------------------------------------------------- #

ID_RE = re.compile(r"^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$")
VERSION_RE = re.compile(r"^(\d+)\.(\d+)$")

RUNTIME_TYPES = ("python", "exec", "powershell", "node", "builtin")
KINDS = ("image", "document", "media", "archive", "vector", "data", "other")


@dataclass
class Runtime:
    type: str = "python"
    entry: str = ""
    args: list[str] = field(default_factory=list)
    python: str = "auto"
    requires: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    cwd: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Runtime":
        return cls(
            type=str(data.get("type", "python")),
            entry=str(data.get("entry", "")),
            args=[str(x) for x in (data.get("args") or [])],
            python=str(data.get("python", "auto")),
            requires=[str(x) for x in (data.get("requires") or [])],
            env={str(k): str(v) for k, v in (data.get("env") or {}).items()},
            cwd=str(data.get("cwd", "")),
        )


@dataclass
class Probe:
    type: str = "none"
    target: str = ""
    args: list[str] = field(default_factory=list)
    expect: str = ""
    min_version: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Probe":
        return cls(
            type=str(data.get("type", "none")),
            target=str(data.get("target", "")),
            args=[str(x) for x in (data.get("args") or [])],
            expect=str(data.get("expect", "")),
            min_version=str(data.get("min_version", "")),
        )


@dataclass
class KernelManifest:
    """内核清单的内存表示。"""

    id: str
    name: str
    version: str
    ckp: str = CKP_VERSION
    description: str = ""
    kind: str = "other"
    homepage: str = ""
    license: str = ""
    priority: int = 50
    tags: list[str] = field(default_factory=list)
    icon: str = ""
    runtime: Runtime = field(default_factory=Runtime)
    capabilities: list[Capability] = field(default_factory=list)
    params: list[ParamSpec] = field(default_factory=list)
    probe: Probe = field(default_factory=Probe)
    hooks: dict[str, dict[str, Any]] = field(default_factory=dict)
    builtin: bool = False
    raw: dict[str, Any] = field(default_factory=dict)

    # -- 序列化 ------------------------------------------------------------- #

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "KernelManifest":
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            version=str(data.get("version", "")),
            ckp=str(data.get("ckp", CKP_VERSION)),
            description=str(data.get("description", "")),
            kind=str(data.get("kind", "other")),
            homepage=str(data.get("homepage", "")),
            license=str(data.get("license", "")),
            priority=int(data.get("priority", 50) or 0),
            tags=[str(x) for x in (data.get("tags") or [])],
            icon=str(data.get("icon", "")),
            runtime=Runtime.from_dict(data.get("runtime") or {}),
            capabilities=[Capability.from_dict(c) for c in (data.get("capabilities") or [])],
            params=[ParamSpec.from_dict(p) for p in (data.get("params") or [])],
            probe=Probe.from_dict(data.get("probe") or {}),
            hooks={k: dict(v) for k, v in (data.get("hooks") or {}).items()},
            builtin=bool(data.get("builtin", False)),
            raw=dict(data),
        )

    @classmethod
    def load(cls, path: str) -> "KernelManifest":
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
        return cls.from_dict(data)

    def to_dict(self) -> dict[str, Any]:
        return dict(self.raw)

    def to_public_dict(self) -> dict[str, Any]:
        """给 GUI 用的精简视图（含归一化后的能力）。"""
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "ckp": self.ckp,
            "description": self.description,
            "kind": self.kind,
            "homepage": self.homepage,
            "license": self.license,
            "priority": self.priority,
            "tags": list(self.tags),
            "builtin": self.builtin,
            "runtime_type": self.runtime.type,
            "requires": list(self.runtime.requires),
            "capabilities": [
                {"id": c.id, "op": c.op, "from": list(c.from_), "to": list(c.to),
                 "multi_in": c.multi_in, "multi_out": c.multi_out, "quality": c.quality}
                for c in self.capabilities
            ],
            "params": [p.raw or {"id": p.id, "type": p.type} for p in self.params],
            "hooks": dict(self.hooks),
            "probe": {"type": self.probe.type, "target": self.probe.target},
        }

    # -- 查询 --------------------------------------------------------------- #

    def ops(self) -> list[str]:
        seen: list[str] = []
        for cap in self.capabilities:
            if cap.op not in seen:
                seen.append(cap.op)
        return seen

    def input_formats(self, op: str | None = None) -> list[str]:
        out: list[str] = []
        for cap in self.capabilities:
            if op and cap.op != op:
                continue
            for f in cap.from_:
                if f != "*" and f not in out:
                    out.append(f)
        return sorted(out)

    def output_formats(self, op: str | None = None) -> list[str]:
        out: list[str] = []
        for cap in self.capabilities:
            if op and cap.op != op:
                continue
            for f in cap.to:
                if f != "*" and f not in out:
                    out.append(f)
        return sorted(out)

    def find_capabilities(self, op: str, src_fmt: str, dst_fmt: str) -> list[Capability]:
        hits = [c for c in self.capabilities
                if c.op == op and c.accepts_input(src_fmt) and c.accepts_output(dst_fmt)]
        return hits


# --------------------------------------------------------------------------- #
# 清单校验
# --------------------------------------------------------------------------- #


def validate_manifest(data: Mapping[str, Any]) -> list[str]:
    """校验清单字典，返回错误列表（空列表 = 合法）。"""
    errors: list[str] = []
    if not isinstance(data, Mapping):
        return ["清单根节点必须是 JSON 对象"]

    for key in ("ckp", "id", "name", "version", "runtime", "capabilities"):
        if key not in data:
            errors.append(f"缺少必填字段 '{key}'")

    version = str(data.get("ckp", ""))
    m = VERSION_RE.match(version)
    if not m:
        errors.append(f"字段 'ckp' 必须形如 '1.0'，实际为 {version!r}")
    elif int(m.group(1)) != CKP_VERSION_MAJOR:
        errors.append(
            f"协议主版本不兼容：内核声明 {version}，宿主支持 {CKP_VERSION} "
            f"(PROTOCOL_VERSION)"
        )

    kid = str(data.get("id", ""))
    if kid and not ID_RE.match(kid):
        errors.append(
            f"字段 'id' 非法：{kid!r} —— 只允许小写字母/数字/._-，且首尾为字母或数字"
        )

    if "name" in data and not str(data.get("name", "")).strip():
        errors.append("字段 'name' 不能为空")
    if "version" in data and not str(data.get("version", "")).strip():
        errors.append("字段 'version' 不能为空")

    kind = data.get("kind")
    if kind is not None and str(kind) not in KINDS:
        errors.append(f"字段 'kind' 非法：{kind!r}，可选 {KINDS}")

    runtime = data.get("runtime")
    if isinstance(runtime, Mapping):
        rtype = str(runtime.get("type", ""))
        if rtype not in RUNTIME_TYPES:
            errors.append(f"runtime.type 非法：{rtype!r}，可选 {RUNTIME_TYPES}")
        if not str(runtime.get("entry", "")).strip():
            errors.append("runtime.entry 不能为空")
    elif runtime is not None:
        errors.append("runtime 必须是对象")

    caps = data.get("capabilities")
    if not isinstance(caps, list) or not caps:
        errors.append("capabilities 必须是非空数组")
    else:
        for i, cap in enumerate(caps):
            if not isinstance(cap, Mapping):
                errors.append(f"capabilities[{i}] 必须是对象")
                continue
            for key in ("op", "from", "to"):
                if not cap.get(key):
                    errors.append(f"capabilities[{i}] 缺少 '{key}'")
            if cap.get("op") is not None and not str(cap.get("op")).strip():
                errors.append(f"capabilities[{i}].op 不能为空")
            for key in ("from", "to"):
                val = cap.get(key)
                if val is not None and not isinstance(val, list):
                    errors.append(f"capabilities[{i}].{key} 必须是数组")

    for group_name in ("params",):
        group = data.get(group_name)
        if group is None:
            continue
        if not isinstance(group, list):
            errors.append(f"{group_name} 必须是数组")
            continue
        for i, spec in enumerate(group):
            if not isinstance(spec, Mapping):
                errors.append(f"{group_name}[{i}] 必须是对象")
                continue
            if not str(spec.get("id", "")).strip():
                errors.append(f"{group_name}[{i}] 缺少 'id'")
            ptype = str(spec.get("type", ""))
            if ptype not in PARAM_TYPES:
                errors.append(f"{group_name}[{i}].type 非法：{ptype!r}，可选 {PARAM_TYPES}")
            if ptype == "enum" and not spec.get("enum"):
                errors.append(f"{group_name}[{i}] 为 enum 类型但未提供 'enum' 取值")

    return errors


# --------------------------------------------------------------------------- #
# 任务
# --------------------------------------------------------------------------- #


@dataclass
class InputRef:
    path: str
    format: str = ""
    role: str = "primary"
    bytes: int | None = None

    @classmethod
    def from_path(cls, path: str, **kw: Any) -> "InputRef":
        fmt = kw.pop("format", "") or format_of_path(path)
        size = None
        try:
            size = os.path.getsize(path)
        except OSError:
            size = None
        return cls(path=os.path.abspath(path), format=fmt, bytes=size, **kw)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"path": self.path, "format": self.format, "role": self.role}
        if self.bytes is not None:
            out["bytes"] = self.bytes
        return out


@dataclass
class OutputRef:
    path: str
    format: str = ""

    @classmethod
    def from_path(cls, path: str, fmt: str = "") -> "OutputRef":
        return cls(path=os.path.abspath(path), format=fmt or format_of_path(path))

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.path, "format": self.format}


def new_job_id() -> str:
    import uuid

    return str(uuid.uuid4())


def build_job(
    op: str,
    inputs: Sequence[InputRef | str],
    outputs: Sequence[OutputRef | str] = (),
    params: Mapping[str, Any] | None = None,
    *,
    kernel: str = "",
    workdir: str = "",
    timeout_ms: int = 0,
    context: Mapping[str, Any] | None = None,
    job_id: str = "",
) -> dict[str, Any]:
    """构造一个符合 CKP 1.0 的 Job 字典。"""
    ins: list[dict[str, Any]] = []
    for item in inputs:
        if isinstance(item, InputRef):
            ins.append(item.to_dict())
        else:
            ins.append(InputRef.from_path(str(item)).to_dict())

    outs: list[dict[str, Any]] = []
    for item in outputs:
        if isinstance(item, OutputRef):
            outs.append(item.to_dict())
        else:
            outs.append(OutputRef.from_path(str(item)).to_dict())

    job: dict[str, Any] = {
        "ckp": CKP_VERSION,
        "job_id": job_id or new_job_id(),
        "op": op,
        "inputs": ins,
        "outputs": outs,
        "params": dict(params or {}),
    }
    if kernel:
        job["kernel"] = kernel
    if workdir:
        job["workdir"] = os.path.abspath(workdir)
    if timeout_ms:
        job["limits"] = {"timeout_ms": int(timeout_ms)}
    job["context"] = {"source": "kernelhub", "locale": "zh-CN", "overwrite": True,
                      **dict(context or {})}
    return job


def validate_job(job: Mapping[str, Any]) -> list[str]:
    """校验 Job 字典，返回错误列表。"""
    errors: list[str] = []
    if not isinstance(job, Mapping):
        return ["Job 根节点必须是对象"]
    for key in ("ckp", "job_id", "op", "inputs"):
        if not job.get(key):
            errors.append(f"缺少必填字段 '{key}'")
    m = VERSION_RE.match(str(job.get("ckp", "")))
    if not m:
        errors.append(f"字段 'ckp' 必须形如 '1.0'，实际为 {job.get('ckp')!r}")
    elif int(m.group(1)) != CKP_VERSION_MAJOR:
        errors.append(f"协议主版本不兼容：{job.get('ckp')} vs {CKP_VERSION}")
    ins = job.get("inputs")
    if not isinstance(ins, list) or not ins:
        errors.append("inputs 必须是非空数组")
    else:
        for i, item in enumerate(ins):
            if not isinstance(item, Mapping) or not item.get("path"):
                errors.append(f"inputs[{i}] 缺少 'path'")
    outs = job.get("outputs")
    if outs is not None:
        if not isinstance(outs, list):
            errors.append("outputs 必须是数组")
        else:
            for i, item in enumerate(outs):
                if not isinstance(item, Mapping) or not item.get("path"):
                    errors.append(f"outputs[{i}] 缺少 'path'")
    params = job.get("params")
    if params is not None and not isinstance(params, Mapping):
        errors.append("params 必须是对象")
    return errors


# --------------------------------------------------------------------------- #
# 事件
# --------------------------------------------------------------------------- #

EVENT_TYPES = ("hello", "log", "progress", "artifact", "result", "error")
TERMINAL_EVENTS = ("result", "error")

LOG_LEVELS = ("debug", "info", "warn", "error")

ERROR_CODES: dict[str, bool] = {
    "UNSUPPORTED_FORMAT": False,
    "BAD_JOB": False,
    "PROTOCOL_VERSION": False,
    "DEPENDENCY_MISSING": False,
    "INPUT_NOT_FOUND": False,
    "INPUT_UNREADABLE": False,
    "OUTPUT_NOT_WRITABLE": True,
    "OUTPUT_EXISTS": True,
    "TIMEOUT": True,
    "CANCELLED": True,
    "ENGINE_CRASH": True,
    "ARTIFACT_MISSING": False,
    "PROTOCOL_NO_TERMINAL_EVENT": False,
    "INTERNAL": True,
}

ERROR_MESSAGES_ZH: dict[str, str] = {
    "UNSUPPORTED_FORMAT": "内核不支持该格式",
    "BAD_JOB": "任务描述不合法",
    "PROTOCOL_VERSION": "协议版本不兼容",
    "DEPENDENCY_MISSING": "内核依赖缺失（引擎未安装）",
    "INPUT_NOT_FOUND": "输入文件不存在",
    "INPUT_UNREADABLE": "输入文件无法读取或解码",
    "OUTPUT_NOT_WRITABLE": "输出路径不可写",
    "OUTPUT_EXISTS": "输出文件已存在",
    "TIMEOUT": "任务超时",
    "CANCELLED": "任务已取消",
    "ENGINE_CRASH": "底层引擎异常退出",
    "ARTIFACT_MISSING": "内核声称产出的文件不存在",
    "PROTOCOL_NO_TERMINAL_EVENT": "适配器结束但未返回终态事件",
    "INTERNAL": "内核内部错误",
}


def parse_event_line(line: str) -> dict[str, Any] | None:
    """解析一行 NDJSON。解析失败返回 None（宿主应记为日志）。"""
    text = line.strip()
    if not text:
        return None
    if not (text.startswith("{") and text.endswith("}")):
        return None
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def is_terminal(event: Mapping[str, Any]) -> bool:
    return str(event.get("type", "")) in TERMINAL_EVENTS


# --------------------------------------------------------------------------- #
# 状态与错误
# --------------------------------------------------------------------------- #

STATUS_READY = "ready"
STATUS_DEGRADED = "degraded"
STATUS_INVALID = "invalid"
STATUS_UNAVAILABLE = "unavailable"
STATUS_DISABLED = "disabled"

STATUS_LABELS_ZH = {
    STATUS_READY: "可用",
    STATUS_DEGRADED: "依赖缺失",
    STATUS_INVALID: "清单非法",
    STATUS_UNAVAILABLE: "未安装",
    STATUS_DISABLED: "已停用",
}


class CkpError(Exception):
    """带 CKP 错误码的异常。"""

    def __init__(self, code: str, message: str, detail: str = "",
                 retryable: bool | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.retryable = ERROR_CODES.get(code, False) if retryable is None else retryable

    def to_event(self, job_id: str = "") -> dict[str, Any]:
        return {
            "type": "error", "ok": False, "ckp": CKP_VERSION, "job_id": job_id,
            "code": self.code, "message": self.message, "detail": self.detail,
            "retryable": self.retryable,
        }

    def __str__(self) -> str:  # pragma: no cover - 展示用
        return f"[{self.code}] {self.message}"


class ManifestError(CkpError):
    def __init__(self, message: str, detail: str = "") -> None:
        super().__init__("BAD_JOB", message, detail)


class NoKernelError(CkpError):
    def __init__(self, message: str, detail: str = "") -> None:
        super().__init__("UNSUPPORTED_FORMAT", message, detail)
