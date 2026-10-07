"""命令行入口：不依赖 GUI 也能完整使用整套内核能力。

::

    python -m kernelhub list
    python -m kernelhub targets photo.png
    python -m kernelhub convert photo.png --to webp --out out/
    python -m kernelhub batch ./images --to jpg --out ./out --recursive
    python -m kernelhub doctor
    python -m kernelhub gui
"""

from __future__ import annotations

import argparse
import glob as globmod
import json
import os
import sys
from typing import Any, Sequence

from kernelhub import __version__, paths
from kernelhub.jobs import ConvertRequest, Hub
from kernelhub.protocol import (
    CKP_VERSION,
    STATUS_LABELS_ZH,
    CkpError,
    canonical_format,
    format_of_path,
)

# --------------------------------------------------------------------------- #
# 输出辅助
# --------------------------------------------------------------------------- #

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text


def bold(t: str) -> str:
    return _c(t, "1")


def dim(t: str) -> str:
    return _c(t, "2")


def green(t: str) -> str:
    return _c(t, "32")


def yellow(t: str) -> str:
    return _c(t, "33")


def red(t: str) -> str:
    return _c(t, "31")


def cyan(t: str) -> str:
    return _c(t, "36")


STATUS_COLOR = {
    "ready": green,
    "degraded": yellow,
    "invalid": red,
    "unavailable": dim,
    "disabled": dim,
}


def print_header(title: str) -> None:
    print()
    print(bold(f"── {title} " + "─" * max(0, 60 - len(title))))


# --------------------------------------------------------------------------- #
# 子命令
# --------------------------------------------------------------------------- #


def cmd_list(args: argparse.Namespace) -> int:
    hub = Hub()
    hub.refresh()
    entries = hub.registry.all_entries()

    if args.json:
        print(json.dumps([e.to_public_dict() for e in entries], ensure_ascii=False, indent=2))
        return 0

    print_header(f"已发现 {len(entries)} 个内核（CKP {CKP_VERSION}）")
    if not entries:
        print("  没有找到任何内核。检查目录：")
        for p in paths.plugin_search_paths():
            print(f"    {p}  {'(存在)' if os.path.isdir(p) else '(不存在)'}")
        return 1

    for entry in entries:
        color = STATUS_COLOR.get(entry.status, str)
        label = STATUS_LABELS_ZH.get(entry.status, entry.status)
        ops = ",".join(entry.manifest.ops()) or "-"
        print(f"\n  {bold(entry.name)} {dim('[' + entry.id + ']')}")
        print(f"    状态: {color(label)}  版本: {entry.manifest.version}  "
              f"优先级: {entry.manifest.priority}")
        if entry.manifest.description:
            print(f"    说明: {entry.manifest.description[:100]}")
        print(f"    操作: {cyan(ops)}")
        ins = entry.manifest.input_formats()
        outs = entry.manifest.output_formats()
        print(f"    输入: {', '.join(ins[:16])}{' …' if len(ins) > 16 else ''}")
        print(f"    输出: {', '.join(outs[:16])}{' …' if len(outs) > 16 else ''}")
        if entry.detail:
            print(f"    {yellow('提示:')} {entry.detail}")
        if entry.status != "ready" and entry.install_hint():
            print(f"    {dim('安装: ' + entry.install_hint())}")
    print()
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    hub = Hub()
    hub.refresh()
    entry = hub.registry.get(args.kernel)
    if entry is None:
        print(red(f"找不到内核: {args.kernel}"))
        return 1
    print(json.dumps(entry.to_public_dict(), ensure_ascii=False, indent=2))
    return 0


def cmd_ops(args: argparse.Namespace) -> int:
    hub = Hub()
    hub.refresh()
    ops = hub.registry.ops()
    if args.json:
        print(json.dumps(ops, ensure_ascii=False))
        return 0
    print_header("可用操作")
    for op in ops:
        srcs = hub.registry.input_formats(op)
        dsts = hub.registry.output_formats(op)
        print(f"  {bold(op):<24} {len(srcs)} 种输入 → {len(dsts)} 种输出")
    print()
    return 0


def cmd_formats(args: argparse.Namespace) -> int:
    hub = Hub()
    hub.refresh()
    fmt = canonical_format(args.source or "")
    if fmt:
        targets = hub.registry.targets_for(args.op, fmt)
        print_header(f"{fmt} 可转换为（{args.op}）")
        print("  " + (", ".join(targets) if targets else red("（无）")))
        print()
        return 0 if targets else 1
    srcs = hub.registry.input_formats(args.op)
    dsts = hub.registry.output_formats(args.op)
    print_header(f"操作 {args.op} 支持的格式")
    print(f"  输入 ({len(srcs)}): {', '.join(srcs)}")
    print(f"  输出 ({len(dsts)}): {', '.join(dsts)}")
    print()
    return 0


def cmd_targets(args: argparse.Namespace) -> int:
    """某个输入文件在 convert 操作下能转成哪些格式。"""
    fmt = format_of_path(args.file)
    if not fmt:
        print(red(f"无法从文件名推断格式: {args.file}"))
        return 1
    hub = Hub()
    hub.refresh()
    targets = hub.registry.targets_for("convert", fmt)
    print_header(f"{fmt} 可转换为（convert）  源文件: {os.path.basename(args.file)}")
    if targets:
        for i in range(0, len(targets), 8):
            print("  " + "  ".join(f"{t:<7}" for t in targets[i:i + 8]))
    else:
        print("  " + red("（无）"))
    print()
    return 0 if targets else 1


def _parse_params(raw: Sequence[str]) -> dict[str, Any]:
    params: dict[str, Any] = {}
    for item in raw or []:
        if "=" not in item:
            raise SystemExit(red(f"--param 需要 key=value 形式，收到: {item}"))
        key, _, value = item.partition("=")
        key = key.strip()
        text = value.strip()
        low = text.lower()
        if low in ("true", "yes", "on"):
            params[key] = True
        elif low in ("false", "no", "off"):
            params[key] = False
        else:
            try:
                params[key] = int(text)
            except ValueError:
                try:
                    params[key] = float(text)
                except ValueError:
                    params[key] = text
    return params


def _progress_printer(enabled: bool):
    state = {"last": -1}

    def on_progress(value: float, message: str) -> None:
        if not enabled:
            return
        pct = int(value * 100)
        if pct != state["last"]:
            state["last"] = pct
            bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
            sys.stdout.write(f"\r  [{bar}] {pct:3d}% {message[:40]:<40}")
            sys.stdout.flush()

    return on_progress


def _log_printer(enabled: bool, verbose: bool):
    def on_log(message: str, level: str) -> None:
        if not enabled:
            return
        if level == "debug" and not verbose:
            return
        prefix = {"debug": dim("·"), "info": cyan("i"), "warn": yellow("!"),
                  "error": red("x")}.get(level, "·")
        sys.stdout.write("\r" + " " * 70 + "\r")
        print(f"  {prefix} {message}")
    return on_log


def _run_and_report(hub: Hub, req: ConvertRequest, args: argparse.Namespace) -> tuple[bool, list[dict]]:
    quiet = getattr(args, "quiet", False)
    verbose = getattr(args, "verbose", False)
    show_progress = not quiet and not getattr(args, "json", False)

    try:
        entry, _cap, outputs = hub.plan(req)
    except CkpError as exc:
        print(red(f"✗ 规划失败 [{exc.code}] {exc.message}"))
        if exc.detail and verbose:
            print(dim(exc.detail))
        return False, []

    if not quiet:
        print(f"  内核: {bold(entry.name)} {dim('[' + entry.id + ']')}")
        print(f"  引擎: {entry.engine_note or '未知'}")
        for src, dst in zip(req.sources, outputs):
            print(f"  {os.path.basename(src)}  →  {bold(os.path.basename(dst))}")

    outcome = hub.convert(
        req,
        on_progress=_progress_printer(show_progress),
        on_log=_log_printer(not quiet, verbose),
    )

    if show_progress:
        sys.stdout.write("\r" + " " * 78 + "\r")

    if outcome.ok:
        if not quiet:
            prim = outcome.primary_output() or {}
            size = prim.get("bytes", 0)
            print(green("  ✓ 成功") +
                  f"  {len(outcome.outputs)} 个产物  {outcome.duration_ms} ms" +
                  (f"  {size / 1024:.1f} KB" if size else ""))
            for out in outcome.outputs:
                print(f"    → {out.get('path')}")
        return True, outcome.outputs

    err = outcome.error or {}
    print(red(f"  ✗ 失败 [{err.get('code', '?')}] {err.get('message', '')}"))
    detail = str(err.get("detail", "")).strip()
    if detail and verbose:
        print(dim("\n".join(detail.splitlines()[-15:])))
    elif detail:
        print(dim("  （加 -v 查看详细错误）"))
    return False, []


def cmd_convert(args: argparse.Namespace) -> int:
    hub = Hub()
    hub.refresh()
    req = ConvertRequest(
        sources=[os.path.abspath(s) for s in args.sources],
        target_format=canonical_format(args.to or ""),
        op=args.op,
        out_dir=os.path.abspath(args.out) if args.out and not args.out_as_file else "",
        out_path=os.path.abspath(args.out) if args.out and args.out_as_file else "",
        params=_parse_params(args.param),
        kernel_id=args.kernel or "",
        timeout_ms=int(args.timeout * 1000) if args.timeout else 0,
    )
    if not req.target_format:
        req.target_format = format_of_path(req.sources[0])
    ok, outputs = _run_and_report(hub, req, args)
    if args.json:
        print(json.dumps(outputs, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def _gather_inputs(args: argparse.Namespace) -> list[str]:
    found: list[str] = []
    for item in args.inputs:
        if os.path.isdir(item):
            pattern = "**/*" if args.recursive else "*"
            for path in sorted(globmod.glob(os.path.join(item, pattern), recursive=args.recursive)):
                if os.path.isfile(path):
                    found.append(path)
        elif any(ch in item for ch in "*?["):
            found.extend(sorted(p for p in globmod.glob(item, recursive=True) if os.path.isfile(p)))
        elif os.path.isfile(item):
            found.append(item)
    if args.glob:
        found = [p for p in found if globmod.fnmatch.fnmatch(os.path.basename(p).lower(),
                                                            args.glob.lower())]
    return found


def cmd_batch(args: argparse.Namespace) -> int:
    hub = Hub()
    hub.refresh()
    sources = _gather_inputs(args)
    if not sources:
        print(red("没有匹配到任何输入文件"))
        return 1

    print_header(f"批量转换 {len(sources)} 个文件 → {canonical_format(args.to)}")
    ok_count = 0
    fail_count = 0
    results: list[dict[str, Any]] = []
    for idx, src in enumerate(sources, 1):
        print(f"\n[{idx}/{len(sources)}] {os.path.basename(src)}")
        req = ConvertRequest(
            sources=[src],
            target_format=canonical_format(args.to),
            op=args.op,
            out_dir=os.path.abspath(args.out) if args.out else "",
            params=_parse_params(args.param),
            kernel_id=args.kernel or "",
            timeout_ms=int(args.timeout * 1000) if args.timeout else 0,
        )
        quiet = args.quiet
        args.quiet = True
        ok, outputs = _run_and_report(hub, req, args)
        args.quiet = quiet
        results.extend(outputs)
        if ok:
            ok_count += 1
            print(green("  ✓ ") + f"{os.path.basename(src)} → " +
                  ", ".join(os.path.basename(o.get('path', '')) for o in outputs))
        else:
            fail_count += 1

    print_header("批量结果")
    print(f"  成功 {green(str(ok_count))} / 失败 {red(str(fail_count)) if fail_count else '0'} "
          f"/ 共 {len(sources)}")
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    print()
    return 0 if fail_count == 0 else 1


def cmd_doctor(args: argparse.Namespace) -> int:
    hub = Hub()
    hub.refresh()
    info = hub.doctor()
    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    print_header("环境")
    print(f"  Python      : {info['python']}  ({info['executable']})")
    print(f"  平台        : {info['platform']}")
    print(f"  协议版本    : CKP {info['protocol']}   KernelHub {__version__}")
    print(f"  项目根      : {info['paths']['project_root']}")
    print(f"  vendor 依赖 : {info['paths']['vendor']}")
    print(f"  内核目录    : {info['paths']['plugins']}")

    reg = info["registry"]
    print_header(f"内核（可用 {reg['ready']} / 共 {reg['total']}）")
    for kern in info["kernels"]:
        color = STATUS_COLOR.get(kern["status"], str)
        label = STATUS_LABELS_ZH.get(kern["status"], kern["status"])
        print(f"  {kern['id']:<22} {color(label):<12} "
              f"{'、'.join(kern['ops']) or '-'}")
        if kern["status"] != "ready" and kern["detail"]:
            print(f"      {dim(kern['detail'])}")
        if kern["install_hint"]:
            print(f"      {dim('安装: ' + kern['install_hint'])}")

    if reg["errors"]:
        print_header("注册表警告")
        for err in reg["errors"]:
            print(f"  {yellow('!')} {err}")

    print_header("搜索路径")
    for path in reg["search_paths"]:
        mark = green("✓") if os.path.isdir(path) else dim("✗")
        print(f"  {mark} {path}")
    print()
    return 0 if reg["ready"] else 1


def cmd_schema(args: argparse.Namespace) -> int:
    schema_dir = paths.SCHEMA_DIR
    names = ["kernel-manifest.schema.json", "job.schema.json", "event.schema.json"]
    if args.name:
        names = [n for n in names if args.name in n]
    print_header(f"协议 Schema 目录：{schema_dir}")
    for name in names:
        path = os.path.join(schema_dir, name)
        exists = os.path.isfile(path)
        print(f"  {'✓' if exists else '✗'} {path}")
        if exists and args.dump:
            with open(path, "r", encoding="utf-8") as fh:
                print(fh.read())
    return 0


def cmd_gui(args: argparse.Namespace) -> int:
    from kernelhub.gui import launch

    return launch(auto_scan=not args.no_scan)


def cmd_serve(args: argparse.Namespace) -> int:
    """无界面 JSON-RPC 服务（供外部程序驱动内核）。"""
    from kernelhub.server import serve

    return serve(host=args.host, port=args.port)


# --------------------------------------------------------------------------- #
# 解析
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kernelhub",
        description=f"KernelHub · CKP {CKP_VERSION} 格式转换内核中枢",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python -m kernelhub list\n"
               "  python -m kernelhub convert a.png --to webp --out out/\n"
               "  python -m kernelhub batch ./pics --to jpg --out ./out -r\n"
               "  python -m kernelhub gui\n",
    )
    parser.add_argument("--version", action="version",
                        version=f"KernelHub {__version__} (CKP {CKP_VERSION})")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("list", help="列出所有内核")
    p.add_argument("--json", action="store_true", help="输出 JSON")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("info", help="查看内核详情")
    p.add_argument("kernel", help="内核 id")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("ops", help="列出可用操作")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_ops)

    p = sub.add_parser("formats", help="查看支持的格式 / 某格式能转成什么")
    p.add_argument("source", nargs="?", default="", help="源格式，留空则列出全部")
    p.add_argument("--op", default="convert", help="操作类型，默认 convert")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_formats)

    p = sub.add_parser("targets", help="某个文件能转成哪些格式")
    p.add_argument("file", help="输入文件")
    p.set_defaults(func=cmd_targets)

    p = sub.add_parser("convert", help="转换文件")
    p.add_argument("sources", nargs="+", help="输入文件")
    p.add_argument("--to", "-t", required=True, help="目标格式，如 jpg / webp / pdf")
    p.add_argument("--out", "-o", default="", help="输出目录（多输入）或输出文件（单输入）")
    p.add_argument("--op", default="convert", help="操作类型（convert/transform/optimize/…）")
    p.add_argument("--kernel", "-k", default="", help="强制指定内核 id")
    p.add_argument("--param", "-p", action="append", default=[],
                   help="内核参数 key=value，可重复")
    p.add_argument("--timeout", type=float, default=0, help="超时秒数")
    p.add_argument("--json", action="store_true", help="输出 JSON 结果")
    p.add_argument("--quiet", "-q", action="store_true")
    p.add_argument("--verbose", "-v", action="store_true")
    p.set_defaults(func=cmd_convert, out_as_file=False)

    p = sub.add_parser("batch", help="批量转换")
    p.add_argument("inputs", nargs="+", help="目录、通配符或文件")
    p.add_argument("--to", "-t", required=True, help="目标格式")
    p.add_argument("--out", "-o", required=True, help="输出目录")
    p.add_argument("--op", default="convert")
    p.add_argument("--kernel", "-k", default="")
    p.add_argument("--param", "-p", action="append", default=[])
    p.add_argument("--recursive", "-r", action="store_true", help="递归子目录")
    p.add_argument("--glob", default="", help="文件名过滤，如 *.png")
    p.add_argument("--timeout", type=float, default=0)
    p.add_argument("--json", action="store_true")
    p.add_argument("--quiet", "-q", action="store_true")
    p.add_argument("--verbose", "-v", action="store_true")
    p.set_defaults(func=cmd_batch)

    p = sub.add_parser("doctor", help="环境与内核自检")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("schema", help="查看协议 Schema 位置")
    p.add_argument("name", nargs="?", default="")
    p.add_argument("--dump", action="store_true", help="打印内容")
    p.set_defaults(func=cmd_schema)

    p = sub.add_parser("gui", help="启动图形界面")
    p.add_argument("--no-scan", action="store_true", help="启动时不自动扫描")
    p.set_defaults(func=cmd_gui)

    p = sub.add_parser("serve", help="启动本地 JSON 服务（无界面）")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8760)
    p.set_defaults(func=cmd_serve)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    # 单输入 + --out 指向一个带扩展名的路径 => 当作输出文件
    raw = list(sys.argv[1:] if argv is None else argv)
    if "--out" in raw or "-o" in raw:
        try:
            flag = "--out" if "--out" in raw else "-o"
            idx = raw.index(flag)
            value = raw[idx + 1] if idx + 1 < len(raw) else ""
            if value and os.path.splitext(value)[1]:
                raw.append("--out-as-file")
        except (ValueError, IndexError):
            pass

    parser = build_parser()
    parser.add_argument("--out-as-file", dest="out_as_file", action="store_true",
                        help=argparse.SUPPRESS)
    args = parser.parse_args(raw)
    try:
        return int(args.func(args) or 0)
    except CkpError as exc:
        print(red(f"[{exc.code}] {exc.message}"))
        if exc.detail:
            print(dim(exc.detail))
        return 1
    except KeyboardInterrupt:
        print(yellow("\n已中断"))
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
