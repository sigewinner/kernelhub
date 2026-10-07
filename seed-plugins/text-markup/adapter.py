#!/usr/bin/env python3
"""文本 / 标记语言内核 · CKP 1.0 适配器。

Markdown ⇄ HTML ⇄ 纯文本 互转。可选引擎：markdown、html2text（均已随项目安装）。

::

    md   --markdown-->  html
    md   --markdown->html2text-->  text / md
    html --html2text--> text / md
    text --wrap-->      html（保留换行的 <pre>）
"""

from __future__ import annotations

import html as htmllib
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
for _p in (os.path.join(_ROOT, "vendor"), _ROOT):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

from kernelhub.sdk import (  # noqa: E402
    CkpError,
    KernelApp,
    canonical_format,
    emit_artifact,
    ensure_parent,
    format_of_path,
)

KERNEL_ID = "text-markup"
VERSION = "1.0.0"

MD_ALIASES = {"md", "markdown", "mdown", "mkd"}
HTML_ALIASES = {"html", "htm", "xhtml"}
TEXT_ALIASES = {"text", "txt", "log", "plain"}


def _read(path: str) -> str:
    if not os.path.isfile(path):
        raise CkpError("INPUT_NOT_FOUND", f"输入文件不存在: {path}")
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            with open(path, "r", encoding=encoding, newline="") as fh:
                return fh.read()
        except UnicodeDecodeError:
            continue
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def _write(path: str, text: str) -> None:
    ensure_parent(path)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _md_to_html(text: str, params: dict) -> str:
    try:
        import markdown
    except ImportError as exc:
        raise CkpError("DEPENDENCY_MISSING",
                       "未安装 markdown：python tools/pip_bootstrap.py install --target vendor markdown",
                       str(exc)) from exc

    extensions = ["tables", "fenced_code", "codehilite", "toc", "sane_lists", "nl2br"]
    if params.get("extensions"):
        extensions = [e.strip() for e in str(params["extensions"]).split(",") if e.strip()]
    body = markdown.markdown(text, extensions=extensions, output_format="html5")
    title = str(params.get("title") or "Document")
    return (
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        f"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{htmllib.escape(title)}</title>\n"
        "<style>body{max-width:52rem;margin:2rem auto;padding:0 1rem;"
        "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.7}"
        "pre{background:#f6f8fa;padding:1rem;overflow:auto;border-radius:6px}"
        "code{background:#f6f8fa;padding:.1rem .3rem;border-radius:3px}"
        "table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.4rem .7rem}"
        "blockquote{border-left:4px solid #ddd;margin:0;padding-left:1rem;color:#555}"
        "</style>\n</head>\n<body>\n" + body + "\n</body>\n</html>\n"
    )


def _html_to_text(text: str, params: dict) -> str:
    try:
        import html2text
    except ImportError as exc:
        raise CkpError("DEPENDENCY_MISSING",
                       "未安装 html2text：python tools/pip_bootstrap.py install --target vendor html2text",
                       str(exc)) from exc

    conv = html2text.HTML2Text()
    conv.body_width = int(params.get("wrap_width") or 0)
    conv.ignore_links = bool(params.get("ignore_links", False))
    conv.ignore_images = bool(params.get("ignore_images", True))
    conv.unicode_snob = True
    return conv.handle(text)


def _text_to_md(text: str) -> str:
    lines = text.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            out.append("")
        elif len(stripped) < 60 and stripped.endswith(("：", ":", "。", ".")) is False \
                and stripped == stripped.upper() and any(c.isalpha() for c in stripped):
            out.append(f"## {stripped}")
        else:
            out.append(line)
    return "\n".join(out).rstrip() + "\n"


def _strip_md(text: str) -> str:
    """极简 Markdown -> 纯文本（不需要外部依赖）。"""
    out = re.sub(r"```.*?```", "", text, flags=re.S)
    out = re.sub(r"`([^`]*)`", r"\1", out)
    out = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", out)
    out = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", out)
    out = re.sub(r"^\s{0,3}#{1,6}\s*", "", out, flags=re.M)
    out = re.sub(r"^\s{0,3}>\s?", "", out, flags=re.M)
    out = re.sub(r"(\*\*|__)(.*?)\1", r"\2", out)
    out = re.sub(r"(\*|_)(.*?)\1", r"\2", out)
    out = re.sub(r"^\s*[-*+]\s+", "• ", out, flags=re.M)
    out = re.sub(r"^\s*\|.*\|\s*$",
                 lambda m: "  ".join(c.strip() for c in m.group(0).strip().strip("|").split("|")),
                 out, flags=re.M)
    out = re.sub(r"^\s*[-:| ]{3,}\s*$", "", out, flags=re.M)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip() + "\n"


def main(argv=None) -> int:
    engine = ""
    try:
        import markdown as _md

        engine = f"markdown {getattr(_md, '__version__', '?')}"
    except ImportError:
        pass
    try:
        import html2text as _h2t

        engine = (engine + " + " if engine else "") + \
                 f"html2text {getattr(_h2t, '__version__', '?')}"
    except ImportError:
        pass

    app = KernelApp(KERNEL_ID, VERSION, engine=engine or "内置转换器")

    def handler(job, _app):
        inputs = job.get("inputs") or []
        outputs = job.get("outputs") or []
        if not inputs or not outputs:
            raise CkpError("BAD_JOB", "需要一个输入与一个输出")

        src = inputs[0]["path"]
        dst = outputs[0]["path"]
        src_fmt = canonical_format(inputs[0].get("format") or format_of_path(src))
        dst_fmt = canonical_format(outputs[0].get("format") or format_of_path(dst))
        params = dict(job.get("params") or {})

        _app.progress(0.25, "读取源文件")
        text = _read(src)
        _app.log(f"源 {src_fmt}，{len(text)} 字符")

        _app.progress(0.55, f"转换到 {dst_fmt}")
        if src_fmt in MD_ALIASES:
            if dst_fmt in HTML_ALIASES:
                result = _md_to_html(text, params)
            elif dst_fmt in TEXT_ALIASES:
                result = _strip_md(text)
            elif dst_fmt in MD_ALIASES:
                result = text
            elif dst_fmt == "json":
                result = json.dumps({"markdown": text}, ensure_ascii=False, indent=2)
            else:
                raise CkpError("UNSUPPORTED_FORMAT", f"Markdown 无法转换为 {dst_fmt}")
        elif src_fmt in HTML_ALIASES:
            if dst_fmt in TEXT_ALIASES:
                result = _html_to_text(text, params)
            elif dst_fmt in MD_ALIASES:
                result = _html_to_text(text, params)
            elif dst_fmt in HTML_ALIASES:
                result = text
            else:
                raise CkpError("UNSUPPORTED_FORMAT", f"HTML 无法转换为 {dst_fmt}")
        elif src_fmt in TEXT_ALIASES:
            if dst_fmt in HTML_ALIASES:
                title = htmllib.escape(str(params.get("title") or
                                           os.path.splitext(os.path.basename(src))[0]))
                pre = htmllib.escape(text)
                result = ("<!doctype html>\n<html lang=\"zh-CN\"><head>"
                          "<meta charset=\"utf-8\">"
                          f"<title>{title}</title></head><body>\n"
                          f"<pre style=\"white-space:pre-wrap;font-family:ui-monospace,"
                          f"Consolas,monospace\">{pre}</pre>\n</body></html>\n")
            elif dst_fmt in MD_ALIASES:
                result = _text_to_md(text)
            elif dst_fmt in TEXT_ALIASES:
                result = text
            else:
                raise CkpError("UNSUPPORTED_FORMAT", f"纯文本无法转换为 {dst_fmt}")
        else:
            raise CkpError("UNSUPPORTED_FORMAT",
                           f"文本内核不支持读取 {src_fmt}（支持 md / html / txt）")

        _app.progress(0.85, "写出")
        _write(dst, result)
        meta = {"input_chars": len(text), "output_chars": len(result),
                "from": src_fmt, "to": dst_fmt, "engine": engine}
        return [emit_artifact(dst, dst_fmt, primary=True, meta=meta)]

    return app.run(handler, argv)


if __name__ == "__main__":
    raise SystemExit(main())
