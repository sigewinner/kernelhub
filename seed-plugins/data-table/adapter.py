#!/usr/bin/env python3
"""表格数据内核 · CKP 1.0 适配器。

CSV / TSV / JSON / XLSX / Markdown 表格 之间互转。
CSV/JSON/Markdown 用标准库，XLSX 用 openpyxl。
"""

from __future__ import annotations

import csv
import io
import json
import os
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

KERNEL_ID = "data-table"
VERSION = "1.0.0"

CSV_LIKE = {"csv", "tsv", "text", "txt"}
TABLE_FORMATS = CSV_LIKE | {"json", "xlsx", "xlsm", "md", "markdown", "html", "htm"}


def _read_text(path: str) -> str:
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


def _load_table(path: str, fmt: str, params: dict):
    """返回 (headers, rows)。headers 可为空列表（纯数组 JSON）。"""
    if fmt in CSV_LIKE:
        text = _read_text(path)
        delimiter = "\t" if fmt == "tsv" else str(params.get("delimiter") or ",")
        reader = csv.reader(io.StringIO(text), delimiter=delimiter)
        rows = [r for r in reader if any(c.strip() for c in r)]
        if not rows:
            return [], []
        has_header = bool(params.get("has_header", True))
        if has_header and len(rows) > 1:
            width = len(rows[0])
            return rows[0], [r + [""] * (width - len(r)) for r in rows[1:]]
        return [], [r for r in rows]

    if fmt == "json":
        data = json.loads(_read_text(path))
        if isinstance(data, dict):
            records = data.get("data") or data.get("records") or data.get("rows") or [data]
        else:
            records = data
        if not isinstance(records, list):
            raise CkpError("INPUT_UNREADABLE", "JSON 顶层必须是数组或含 data 数组的对象")
        headers: list[str] = []
        for rec in records:
            if isinstance(rec, dict):
                for key in rec:
                    if key not in headers:
                        headers.append(str(key))
        rows = []
        for rec in records:
            if isinstance(rec, dict):
                rows.append([_cell(rec.get(h, "")) for h in headers])
            elif isinstance(rec, list):
                rows.append([_cell(v) for v in rec])
            else:
                rows.append([_cell(rec)])
        if not headers and rows:
            headers = [f"col{i + 1}" for i in range(max(len(r) for r in rows))]
        return headers, rows

    if fmt in ("xlsx", "xlsm"):
        try:
            import openpyxl
        except ImportError as exc:
            raise CkpError("DEPENDENCY_MISSING",
                           "未安装 openpyxl：python tools/pip_bootstrap.py install --target vendor openpyxl",
                           str(exc)) from exc
        sheet_name = str(params.get("sheet") or "")
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        ws = wb[sheet_name] if sheet_name and sheet_name in wb.sheetnames else wb[wb.sheetnames[0]]
        values = [[_cell(c) for c in row] for row in ws.iter_rows(values_only=True)]
        wb.close()
        while values and not any(str(c).strip() for c in values[-1]):
            values.pop()
        if not values:
            return [], []
        has_header = bool(params.get("has_header", True))
        if has_header and len(values) > 1:
            width = len(values[0])
            return [str(c) for c in values[0]], [
                [str(c) for c in (r + [""] * (width - len(r)))] for r in values[1:]]
        return [], [[str(c) for c in r] for r in values]

    if fmt in ("md", "markdown"):
        text = _read_text(path)
        lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("|")]
        if not lines:
            raise CkpError("INPUT_UNREADABLE", "没有找到 Markdown 表格行")
        parsed = [[c.strip() for c in ln.strip().strip("|").split("|")] for ln in lines]
        parsed = [p for p in parsed if not all(set(c) <= set("-: ") for c in p)]
        if not parsed:
            return [], []
        return parsed[0], parsed[1:]

    if fmt in ("html", "htm"):
        import html.parser
        import re

        text = _read_text(path)
        rows_raw = re.findall(r"<tr[^>]*>(.*?)</tr>", text, flags=re.S | re.I)
        table: list[list[str]] = []
        for row_raw in rows_raw:
            cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row_raw, flags=re.S | re.I)
            if cells:
                table.append([html.parser.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                              for c in cells])
        if not table:
            return [], []
        return table[0], table[1:]

    raise CkpError("UNSUPPORTED_FORMAT", f"表格内核不支持读取 {fmt}")


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _write_table(path: str, fmt: str, headers: list[str], rows: list[list[str]],
                 params: dict) -> dict:
    ensure_parent(path)
    meta: dict = {"rows": len(rows), "columns": len(headers or (rows[0] if rows else []))}

    if fmt in CSV_LIKE:
        delimiter = "\t" if fmt == "tsv" else str(params.get("delimiter") or ",")
        with open(path, "w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.writer(fh, delimiter=delimiter,
                                quoting=csv.QUOTE_MINIMAL)
            if headers and params.get("write_header", True):
                writer.writerow(headers)
            writer.writerows(rows)
        return meta

    if fmt == "json":
        if headers:
            payload = [{h: r[i] if i < len(r) else "" for i, h in enumerate(headers)}
                       for r in rows]
        else:
            payload = rows
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False,
                                indent=int(params.get("indent") or 2)))
            fh.write("\n")
        return meta

    if fmt in ("xlsx", "xlsm"):
        try:
            import openpyxl
        except ImportError as exc:
            raise CkpError("DEPENDENCY_MISSING", "未安装 openpyxl", str(exc)) from exc
        wb = openpyxl.Workbook(write_only=False)
        ws = wb.active
        ws.title = str(params.get("sheet") or "Sheet1")
        if headers and params.get("write_header", True):
            ws.append(headers)
            for cell in ws[1]:
                cell.font = openpyxl.styles.Font(bold=True)
        for row in rows:
            ws.append([_coerce(v) for v in row])
        for idx, _h in enumerate(headers or [], start=1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = 16
        wb.save(path)
        meta["sheet"] = ws.title
        return meta

    if fmt in ("md", "markdown"):
        header = headers or [f"col{i + 1}" for i in range(meta["columns"])]
        lines = ["| " + " | ".join(header) + " |",
                 "| " + " | ".join("---" for _ in header) + " |"]
        for row in rows:
            padded = list(row) + [""] * (len(header) - len(row))
            lines.append("| " + " | ".join(str(c).replace("|", "\\|")
                                           for c in padded[:len(header)]) + " |")
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")
        return meta

    if fmt in ("html", "htm"):
        import html as htmllib

        header = headers or [f"col{i + 1}" for i in range(meta["columns"])]
        out = ["<!doctype html>", "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
               f"<title>{htmllib.escape(str(params.get('title') or 'Table'))}</title>",
               "<style>table{border-collapse:collapse}td,th{border:1px solid #ccc;"
               "padding:6px 10px;text-align:left}th{background:#f2f2f2}</style>",
               "</head><body>", "<table>", "<thead><tr>"]
        out += [f"<th>{htmllib.escape(str(h))}</th>" for h in header]
        out.append("</tr></thead><tbody>")
        for row in rows:
            padded = list(row) + [""] * (len(header) - len(row))
            out.append("<tr>" + "".join(
                f"<td>{htmllib.escape(str(c))}</td>" for c in padded[:len(header)]) + "</tr>")
        out += ["</tbody></table>", "</body></html>", ""]
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(out))
        return meta

    raise CkpError("UNSUPPORTED_FORMAT", f"表格内核不支持写出 {fmt}")


def _coerce(value: str):
    text = str(value)
    if text == "":
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def main(argv=None) -> int:
    engine = "Python 标准库"
    try:
        import openpyxl

        engine += f" + openpyxl {getattr(openpyxl, '__version__', '?')}"
    except ImportError:
        pass

    app = KernelApp(KERNEL_ID, VERSION, engine=engine)

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

        if dst_fmt not in TABLE_FORMATS:
            raise CkpError("UNSUPPORTED_FORMAT", f"表格内核无法写出 {dst_fmt}")

        _app.progress(0.25, "读取表格")
        headers, rows = _load_table(src, src_fmt, params)
        _app.log(f"读到 {len(rows)} 行 × {len(headers or (rows[0] if rows else []))} 列")

        _app.progress(0.7, f"写出 {dst_fmt}")
        meta = _write_table(dst, dst_fmt, headers, rows, params)
        meta.update({"from": src_fmt, "to": dst_fmt, "engine": engine})
        return [emit_artifact(dst, dst_fmt, primary=True, meta=meta)]

    return app.run(handler, argv)


if __name__ == "__main__":
    raise SystemExit(main())
