"""无界面的本地 JSON 服务 —— 让别的程序也能驱动这些内核。

图形界面适合人用，但这个服务让**任何程序**（脚本、其他语言写的工具、浏览器页面）
都能复用同一套内核与协议::

    python -m kernelhub serve --port 8760

接口::

    GET  /api/health                  健康检查与版本
    GET  /api/kernels                 内核清单（含状态与能力）
    GET  /api/ops                     可用操作
    GET  /api/formats?op=convert      该操作支持的输入/输出格式
    GET  /api/targets?op=convert&source=jpg
    POST /api/convert                 执行转换
         {"sources": ["a.png"], "target": "webp", "op": "convert",
          "out_dir": "...", "params": {...}, "kernel_id": ""}
    POST /api/inspect                 {kernel_id, path} 读取元信息

只监听回环地址，默认不带鉴权，请勿暴露到公网。
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from kernelhub import __version__, paths
from kernelhub.jobs import ConvertRequest, Hub
from kernelhub.protocol import CKP_VERSION, CkpError, canonical_format

_HUB_LOCK = threading.Lock()
_HUB: Hub | None = None


def get_hub(refresh: bool = False) -> Hub:
    global _HUB
    with _HUB_LOCK:
        if _HUB is None:
            _HUB = Hub()
            _HUB.refresh()
        elif refresh:
            _HUB.refresh()
        return _HUB


INDEX_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>KernelHub 本地服务</title>
<style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:52rem;margin:3rem auto;
padding:0 1rem;line-height:1.7}code,pre{background:#f6f8fa;border-radius:6px}
code{padding:.1rem .35rem}pre{padding:1rem;overflow:auto}</style></head><body>
<h1>KernelHub 本地服务</h1>
<p>CKP __CKP__ · KernelHub __VERSION__ · 内核 __READY__/__TOTAL__ 可用</p>
<p>这是一个给程序用的 JSON 接口。图形界面请运行 <code>python -m kernelhub gui</code>。</p>
<h2>接口</h2>
<pre>GET  /api/health
GET  /api/kernels
GET  /api/ops
GET  /api/formats?op=convert
GET  /api/targets?op=convert&amp;source=jpg
POST /api/convert
POST /api/inspect</pre>
<h2>示例</h2>
<pre>curl -X POST http://127.0.0.1:__PORT__/api/convert \\
  -H "Content-Type: application/json" \\
  -d "{\\"sources\\":[\\"D:/pics/a.png\\"],\\"target\\":\\"webp\\",\\"params\\":{\\"quality\\":80}}"</pre>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = f"KernelHub/{__version__}"
    protocol_version = "HTTP/1.1"

    # -- 基础设施 ----------------------------------------------------------- #

    def log_message(self, fmt: str, *args: Any) -> None:
        # 默认实现会往 stderr 狂刷；这里收敛成一行
        if os.environ.get("KERNELHUB_HTTP_LOG"):
            super().log_message(fmt, *args)

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2,
                          default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, text: str, status: int = 200) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise CkpError("BAD_JOB", f"请求体不是合法 JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise CkpError("BAD_JOB", "请求体必须是 JSON 对象")
        return data

    # -- 路由 --------------------------------------------------------------- #

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        route = parsed.path.rstrip("/") or "/"

        try:
            hub = get_hub()
            if route in ("/", "/index.html"):
                summary = hub.registry.summary()
                html = (INDEX_HTML
                        .replace("__CKP__", CKP_VERSION)
                        .replace("__VERSION__", __version__)
                        .replace("__READY__", str(summary["ready"]))
                        .replace("__TOTAL__", str(summary["total"]))
                        .replace("__PORT__", str(self.server.server_address[1])))
                return self._send_html(html)

            if route == "/api/health":
                return self._send_json({
                    "ok": True, "service": "kernelhub", "version": __version__,
                    "protocol": CKP_VERSION, "project_root": paths.PROJECT_ROOT,
                    "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                })

            if route == "/api/kernels":
                if query.get("refresh") in ("1", "true"):
                    hub.refresh()
                return self._send_json({
                    "summary": hub.registry.summary(),
                    "kernels": hub.registry.public_list(),
                })

            if route == "/api/ops":
                return self._send_json(hub.registry.ops())

            if route == "/api/formats":
                op = query.get("op", "convert")
                return self._send_json({
                    "op": op,
                    "inputs": hub.registry.input_formats(op),
                    "outputs": hub.registry.output_formats(op),
                })

            if route == "/api/targets":
                op = query.get("op", "convert")
                source = canonical_format(query.get("source", ""))
                return self._send_json({
                    "op": op, "source": source,
                    "targets": hub.registry.targets_for(op, source),
                })

            if route == "/api/doctor":
                return self._send_json(hub.doctor())

            return self._send_json({"error": "not found", "path": parsed.path}, 404)

        except CkpError as exc:
            return self._send_json(exc.to_event(), 400)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        try:
            payload = self._read_json()
        except CkpError as exc:
            return self._send_json(exc.to_event(), 400)

        hub = get_hub()
        try:
            if route == "/api/convert":
                sources = payload.get("sources") or []
                if isinstance(sources, str):
                    sources = [sources]
                if not sources:
                    raise CkpError("BAD_JOB", "缺少 sources")
                target = canonical_format(
                    str(payload.get("target") or payload.get("to") or ""))
                out_dir = str(payload.get("out_dir") or "")
                out_path = str(payload.get("out_path") or "")
                if not target and not out_path:
                    raise CkpError("BAD_JOB", "缺少 target")
                req = ConvertRequest(
                    sources=[os.path.abspath(str(s)) for s in sources],
                    target_format=target,
                    op=str(payload.get("op") or "convert"),
                    out_dir=os.path.abspath(out_dir) if out_dir else "",
                    out_path=os.path.abspath(out_path) if out_path else "",
                    params=dict(payload.get("params") or {}),
                    kernel_id=str(payload.get("kernel_id") or payload.get("kernel") or ""),
                    timeout_ms=int(payload.get("timeout_ms") or 0),
                )
                outcome = hub.convert(req)
                status = 200 if outcome.ok else 422
                return self._send_json(outcome.to_dict(), status)

            if route == "/api/inspect":
                path = str(payload.get("path") or "")
                if not path:
                    raise CkpError("BAD_JOB", "缺少 path")
                outcome = hub.convert_one(
                    os.path.abspath(path), "json", op="inspect",
                    params=dict(payload.get("params") or {}),
                    kernel_id=str(payload.get("kernel_id") or ""))
                return self._send_json(outcome.to_dict(),
                                       200 if outcome.ok else 422)

            if route == "/api/refresh":
                hub.refresh()
                return self._send_json(hub.registry.summary())

            return self._send_json({"error": "not found", "path": parsed.path}, 404)

        except CkpError as exc:
            return self._send_json(exc.to_event(), 400)
        except Exception as exc:  # noqa: BLE001
            return self._send_json(
                {"error": f"{type(exc).__name__}: {exc}"}, 500)


def serve(host: str = "127.0.0.1", port: int = 8760) -> int:
    """启动本地服务，阻塞直到 Ctrl+C。"""
    hub = get_hub(refresh=True)
    summary = hub.registry.summary()

    if host not in ("127.0.0.1", "localhost", "::1"):
        print(f"[warn] 服务将监听 {host}，这不是回环地址，请确认网络环境可信。")

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    actual_port = httpd.server_address[1]
    url = f"http://{host}:{actual_port}/"

    print(f"KernelHub {__version__} (CKP {CKP_VERSION})")
    print(f"内核: {summary['ready']} 可用 / {summary['total']} 发现")
    print(f"监听: {url}")
    print(f"文档: {url}api/health")
    print("按 Ctrl+C 退出")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭…")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
