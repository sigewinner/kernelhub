"""通用 CLI 桥接器 —— 让「加一个命令行内核」变成纯写配置。

很多优秀的开源转换内核都是命令行程序（ImageMagick、FFmpeg、Pandoc、Inkscape、
Ghostscript、poppler、qpdf、7-Zip、oxipng…）。为它们逐个写适配器是重复劳动。

于是协议允许清单里额外声明一段 ``x-cli`` 配置，插件的 ``adapter.py`` 只需要三行：

.. code-block:: python

    from kernelhub.cli_bridge import CliBridge
    if __name__ == "__main__":
        raise SystemExit(CliBridge(__file__).main())

``x-cli`` 结构::

    "x-cli": {
      "engine": "ImageMagick 7",
      "version_args": ["-version"],
      "templates": [
        { "op": "convert",
          "when": { "to": ["jpg", "jpeg"] },
          "command": "magick",
          "args": ["{input}", "-quality", "{param:quality|88}", "{output}"] },
        { "op": "convert",
          "command": "magick",
          "args": ["{input}", "{output}"] }
      ]
    }

占位符
------

===========================  ==========================================
``{input}`` / ``{input0}``    第 1 个输入路径（``{input1}`` 为第 2 个，依此类推）
``{inputs}``                 全部输入路径，依次展开为多个 argv
``{output}`` / ``{output0}`` 第 1 个输出路径
``{outputs}``                全部输出路径
``{outdir}``                 第 1 个输出所在目录
``{stem}``                   第 1 个输入的文件名（不含扩展名）
``{ext}``                    输出格式标签
``{param:NAME}``             任务参数 ``NAME``
``{param:NAME|默认值}``      带默认值
``{workdir}``                任务工作目录
===========================  ==========================================

输出模式 ``output_mode``
------------------------

``exact``（默认）  命令把结果写到 ``{output}`` 指定的确切路径
``prefix``         命令按前缀写多个文件（如 ``pdftoppm``）；桥接器按 ``{output}*`` 收集
``glob``           命令按模板写多个文件（如 FFmpeg 的 ``%04d`` 序列）；
                   用模板里的 ``output_glob`` 指定收集通配符::

                       { "op": "extract", "output_mode": "glob",
                         "output_glob": "{outdir}/{stem}_*.png",
                         "command": "{exe:ffmpeg}",
                         "args": ["-y", "-i", "{input}", "{outdir}/{stem}_%04d.png"] }

``stdout``         命令把结果打到 stdout，桥接器写入 ``{output}``

可执行文件解析 ``executables``
------------------------------

命令行工具的路径常常不好写死（有的在 PATH，有的随 wheel 一起分发）。
``x-cli.executables`` 声明「怎么找到它」，模板里用 ``{exe:名字}`` 引用::

    "x-cli": {
      "executables": {
        "ffmpeg": {
          "candidates": ["ffmpeg", "ffmpeg.exe"],
          "python": "imageio_ffmpeg:get_ffmpeg_exe",
          "bundled": ["vendor/imageio_ffmpeg/binaries/ffmpeg-*.exe"]
        }
      },
      "templates": [
        { "op": "convert", "command": "{exe:ffmpeg}",
          "args": ["-y", "-i", "{input}", "{output}"] }
      ]
    }

解析顺序（可用 ``prefer`` 重排）：环境变量 ``CKP_EXE_<名字>`` → ``python``
模块函数 → ``bundled`` 通配路径（相对项目根）→ ``candidates`` 在 PATH 中查找。
"""

from __future__ import annotations

import glob as globmod
import os
import re
import shlex
import shutil
import subprocess
import time
from typing import Any, Iterable, Mapping, Sequence

from kernelhub import executables, paths
from kernelhub.sdk import (
    CKP_VERSION,
    CkpError,
    KernelApp,
    emit_artifact,
    format_of_path,
)

_USE_STDERR = subprocess.STDOUT

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z0-9_:.\-|]+)\}")


class CliBridge:
    """由 ``x-cli`` 配置驱动的通用适配器。"""

    def __init__(self, adapter_file: str, kernel_id: str = "",
                 version: str = "1.0.0", plugin_dir: str = "") -> None:
        self.adapter_file = os.path.abspath(adapter_file)
        # 清单位置优先级：显式参数 > 宿主注入的 CKP_PLUGIN_DIR > 适配器所在目录
        self.plugin_dir = os.path.abspath(
            plugin_dir
            or os.environ.get("CKP_PLUGIN_DIR")
            or os.path.dirname(self.adapter_file)
        )
        self.manifest = self._load_manifest()
        self.kernel_id = kernel_id or str(self.manifest.get("id") or "cli-kernel")
        self.version = version or str(self.manifest.get("version") or "1.0.0")
        self.cli_cfg: dict[str, Any] = dict(self.manifest.get("x-cli") or {})
        self.templates: list[dict[str, Any]] = list(self.cli_cfg.get("templates") or [])
        self.engine = str(self.cli_cfg.get("engine") or self.kernel_id)
        self._exe_cache: dict[str, str] = {}

    # -- 可执行文件解析 ----------------------------------------------------- #

    def resolve_executable(self, name: str) -> str:
        """按 ``x-cli.executables`` 的声明找出可执行文件路径（带缓存）。"""
        if name in self._exe_cache:
            return self._exe_cache[name]
        spec = (self.cli_cfg.get("executables") or {}).get(name)
        path, _source = executables.resolve_executable(name, spec, self.plugin_dir)
        self._exe_cache[name] = path
        return path

    # -- 清单 --------------------------------------------------------------- #

    def _load_manifest(self) -> dict[str, Any]:
        import json

        path = os.path.join(self.plugin_dir, "kernel.json")
        try:
            with open(path, "r", encoding="utf-8-sig") as fh:
                return json.load(fh)
        except FileNotFoundError as exc:
            raise CkpError(
                "BAD_JOB",
                f"在 {self.plugin_dir} 找不到内核清单 kernel.json。",
                "如果这个适配器是被共享使用的，请通过 CKP_PLUGIN_DIR 环境变量"
                "或 CliBridge(plugin_dir=...) 指明所属插件目录。",
            ) from exc
        except (OSError, ValueError) as exc:
            raise CkpError("BAD_JOB", f"无法读取内核清单 {path}: {exc}") from exc

    # -- 模板选择 ----------------------------------------------------------- #

    def _template_for(self, job: Mapping[str, Any]) -> dict[str, Any]:
        from kernelhub.protocol import formats_match

        op = str(job.get("op", ""))
        src = ""
        inputs = job.get("inputs") or []
        if inputs:
            src = str(inputs[0].get("format") or format_of_path(str(inputs[0].get("path", ""))))
        dst = ""
        outputs = job.get("outputs") or []
        if outputs:
            dst = str(outputs[0].get("format") or format_of_path(str(outputs[0].get("path", ""))))

        fallback: dict[str, Any] | None = None
        for tpl in self.templates:
            if str(tpl.get("op", "")) != op:
                continue
            when = dict(tpl.get("when") or {})
            if not when:
                fallback = fallback or tpl
                continue
            if self._when_matches(when, src, dst, op):
                return tpl

        if fallback is not None:
            return fallback
        raise CkpError("UNSUPPORTED_FORMAT",
                       f"内核 {self.kernel_id} 没有为操作 '{op}' 配置模板")

    @staticmethod
    def _when_matches(when: Mapping[str, Any], src: str, dst: str, op: str) -> bool:
        from kernelhub.protocol import formats_match

        if when.get("op") and op not in [str(x) for x in when["op"]]:
            return False
        if when.get("from") and not any(formats_match(str(f), src) for f in when["from"]):
            return False
        if when.get("to") and not any(formats_match(str(f), dst) for f in when["to"]):
            return False
        return True

    # -- 占位符 ------------------------------------------------------------- #

    def _context(self, job: Mapping[str, Any], output_path: str) -> dict[str, Any]:
        inputs = [str(i.get("path", "")) for i in (job.get("inputs") or [])]
        outputs = [str(o.get("path", "")) for o in (job.get("outputs") or [])]
        ctx: dict[str, Any] = {
            "input": inputs[0] if inputs else "",
            "inputs": inputs,
            "output": output_path,
            "outputs": outputs,
            "outdir": os.path.dirname(output_path) or ".",
            "workdir": str(job.get("workdir") or ""),
            "stem": os.path.splitext(os.path.basename(inputs[0]))[0] if inputs else "output",
            "ext": format_of_path(output_path),
            "job_id": str(job.get("job_id", "")),
            "plugin_dir": self.plugin_dir,
        }
        for idx, path in enumerate(inputs):
            ctx[f"input{idx}"] = path
        for idx, path in enumerate(outputs):
            ctx[f"output{idx}"] = path
        ctx["params"] = dict(job.get("params") or {})
        return ctx

    def _lookup(self, ctx: Mapping[str, Any], token: str) -> Any:
        if ":" in token:
            kind, _, rest = token.partition(":")
            if kind == "exe":
                return self.resolve_executable(rest)
            if kind == "env":
                name, _, default = rest.partition("|")
                return os.environ.get(name, default)
            if kind == "param":
                name, _, default = rest.partition("|")
                params = ctx.get("params") or {}
                value = params.get(name)
                if value is None or value == "":
                    value = default
                return value
        return ctx.get(token, "")

    def _expand_command(self, raw: str, ctx: Mapping[str, Any]) -> str:
        """把 command 字段里的占位符（如 ``{exe:ffmpeg}``）替换成字符串。"""
        def repl(match: re.Match[str]) -> str:
            value = self._lookup(ctx, match.group(1))
            if isinstance(value, (list, tuple)):
                return " ".join(str(v) for v in value)
            return "" if value is None else str(value)

        return _PLACEHOLDER_RE.sub(repl, raw)

    def _expand(self, raw: str, ctx: Mapping[str, Any]) -> list[str]:
        """把一个参数模板展开成若干 argv 项。

        关键点：**同一字符串里的多个占位符必须拼接在同一个 argv 项里**。
        例如 ``"fps={param:fps}，scale={param:w}"`` 只能产出一个参数，
        而 ``"{inputs}"`` 展开成列表时应当产出多个参数。
        """
        if not raw:
            return []
        matches = list(_PLACEHOLDER_RE.finditer(raw))
        if not matches:
            return [raw]

        # 切成 ("lit", [文本]) / ("val", [候选值...]) 两类片段
        segments: list[tuple[str, list[str]]] = []
        pos = 0
        for match in matches:
            if match.start() > pos:
                segments.append(("lit", [raw[pos:match.start()]]))
            value = self._lookup(ctx, match.group(1))
            if isinstance(value, (list, tuple)):
                items = [str(v) for v in value if str(v) != ""]
                segments.append(("val", items or [""]))
            else:
                segments.append(("val", ["" if value is None else str(value)]))
            pos = match.end()
        if pos < len(raw):
            segments.append(("lit", [raw[pos:]]))

        results: list[str] = [""]
        for kind, items in segments:
            if kind == "lit" or len(items) == 1:
                text = items[0] if items else ""
                results = [prefix + text for prefix in results]
            else:
                # 多值占位符：首值与前面的内容拼接，其余各自成为新的 argv 项
                expanded = [prefix + items[0] for prefix in results]
                expanded.extend(items[1:])
                results = expanded
        return results or [raw]

    # -- 执行 --------------------------------------------------------------- #

    def build_argv(self, job: Mapping[str, Any], output_path: str,
                   template: Mapping[str, Any]) -> list[str]:
        ctx = self._context(job, output_path)
        command_raw = str(template.get("command") or "").strip()
        if not command_raw:
            raise CkpError("BAD_JOB", "x-cli 模板缺少 'command'")
        command = self._expand_command(command_raw, ctx)

        if template.get("shell"):
            argv: list[str] = list(shlex.split(command))
        else:
            argv = [command]

        for raw in (template.get("args") or []):
            argv.extend(self._expand(str(raw), ctx))

        # 可选参数组：值为空时整组跳过，避免出现悬空的 -flag
        for group in (template.get("optional_args") or []):
            if not isinstance(group, Mapping):
                continue
            values = [v for v in self._expand(str(group.get("value", "")), ctx) if v != ""]
            if not values:
                continue
            flag = str(group.get("flag") or "")
            if flag:
                argv.append(flag)
            argv.extend(values)

        # 尾参数：放在可选参数之后（通常是输出路径）
        for raw in (template.get("tail_args") or []):
            argv.extend(self._expand(str(raw), ctx))
        return argv

    def _run_command(self, argv: Sequence[str], cwd: str, timeout: float,
                     capture_stdout: bool) -> tuple[int, str, str]:
        creationflags = 0x08000000 if os.name == "nt" else 0
        try:
            proc = subprocess.run(
                list(argv),
                cwd=cwd if os.path.isdir(cwd) else None,
                capture_output=capture_stdout,
                stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace",
                timeout=timeout,
                creationflags=creationflags,
            )
        except FileNotFoundError as exc:
            raise CkpError("DEPENDENCY_MISSING",
                           f"未找到命令 '{argv[0]}'，请先安装 {self.engine}", str(exc)) from exc
        except subprocess.TimeoutExpired as exc:
            raise CkpError("TIMEOUT", f"{self.engine} 执行超时（>{timeout:.0f}s）", str(exc)) from exc
        except OSError as exc:
            raise CkpError("INTERNAL", f"执行 {self.engine} 失败: {exc}", str(exc)) from exc
        return proc.returncode, proc.stdout or "", proc.stderr or ""

    # -- 主流程 ------------------------------------------------------------- #

    def main(self, argv: Sequence[str] | None = None) -> int:
        app = KernelApp(self.kernel_id, self.version, engine=self.engine)

        def handler(job: dict[str, Any], _app: KernelApp) -> list[dict[str, Any]]:
            op = str(job.get("op", ""))
            template = self._template_for(job)
            output_mode = str(template.get("output_mode") or self.cli_cfg.get("output_mode") or "exact")

            inputs = job.get("inputs") or []
            if not inputs:
                raise CkpError("BAD_JOB", "任务没有输入文件")
            for item in inputs:
                path = str(item.get("path", ""))
                if not os.path.isfile(path):
                    raise CkpError("INPUT_NOT_FOUND", f"输入文件不存在: {path}")

            outputs = list(job.get("outputs") or [])
            out_fmt = ""
            if outputs:
                out_fmt = str(outputs[0].get("format")
                              or format_of_path(str(outputs[0].get("path", ""))))

            workdir = str(job.get("workdir") or os.path.dirname(str(inputs[0]["path"])))
            paths.ensure_dir(workdir)

            if not outputs:
                raise CkpError("BAD_JOB", f"操作 '{op}' 需要 outputs")

            timeout_ms = int((job.get("limits") or {}).get("timeout_ms", 0) or 600_000)
            timeout = max(1.0, min(timeout_ms, 1_800_000) / 1000.0)

            primary_out = str(outputs[0]["path"])
            paths.ensure_dir(os.path.dirname(primary_out) or workdir)

            capture_stdout = output_mode == "stdout"
            target = primary_out

            argv = self.build_argv(job, target, template)

            _app.log(f"执行: {' '.join(argv)}")
            _app.progress(0.15, "启动引擎")
            t0 = time.time()
            code, stdout_text, stderr_text = self._run_command(
                argv, workdir, timeout, capture_stdout)
            elapsed = time.time() - t0
            _app.progress(0.85, "引擎完成")

            tail = "\n".join((stderr_text or "").strip().splitlines()[-12:])
            if stderr_text and stderr_text.strip():
                for line in stderr_text.strip().splitlines()[-6:]:
                    _app.log(line, "debug")

            produced: list[str] = []

            if output_mode == "stdout":
                if code != 0:
                    raise CkpError("ENGINE_CRASH",
                                   f"{self.engine} 退出码 {code}", tail or stdout_text[-2000:])
                with open(primary_out, "w", encoding="utf-8", newline="") as fh:
                    fh.write(stdout_text)
                produced = [primary_out]
            elif output_mode == "prefix":
                pattern = target + "*"
                found = sorted(p for p in globmod.glob(pattern) if os.path.isfile(p))
                produced = found
            elif output_mode == "glob":
                pattern_raw = str(template.get("output_glob")
                                  or self.cli_cfg.get("output_glob") or (target + "*"))
                pattern = self._expand_command(pattern_raw, self._context(job, target))
                found = sorted(p for p in globmod.glob(pattern) if os.path.isfile(p))
                produced = found
                if not found:
                    _app.log(f"未匹配到产物：{pattern}", "warn")
            else:
                produced = [str(o["path"]) for o in outputs]

            existing = [p for p in produced if os.path.isfile(p) and os.path.getsize(p) > 0]
            if not existing:
                raise CkpError("ENGINE_CRASH",
                               f"{self.engine} 未产出任何文件（退出码 {code}）",
                               tail or stdout_text[-2000:])

            if code != 0:
                _app.log(f"{self.engine} 返回非零退出码 {code}，但已产出文件，继续。", "warn")

            metas: list[dict[str, Any]] = []
            for idx, path in enumerate(existing):
                fmt = format_of_path(path) or out_fmt
                info = emit_artifact(path, fmt, primary=(idx == 0),
                                     meta={"engine": self.engine})
                metas.append(info)
            _app.log(f"耗时 {elapsed:.2f}s，产出 {len(existing)} 个文件")
            return metas

        return app.run(handler, argv)
