#!/usr/bin/env python3
"""纯标准库图像内核 · CKP 1.0 适配器（KernelHub 自造，零第三方依赖）。

当机器上没有任何第三方图像库时，这个内核保证 png / bmp / ppm / pgm / pbm /
tga 之间依然可以互转。它是「无满足的插件就自行创造」的落地样例。
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
for _p in (os.path.join(_ROOT, "vendor"), _ROOT, _HERE):
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

import codecs_std  # noqa: E402
from codecs_std import CodecError, Image  # noqa: E402

KERNEL_ID = "stdlib-image"
VERSION = "1.1.0"
ENGINE = f"Python {sys.version_info.major}.{sys.version_info.minor} 标准库 (zlib/struct)"

SUPPORTED = ("png", "bmp", "ppm", "pgm", "pbm", "pnm", "tga")


def _nearest_resize(img: Image, width: int, height: int) -> Image:
    out = bytearray(width * height * img.channels)
    ch = img.channels
    sx = img.width / width
    sy = img.height / height
    for y in range(height):
        syi = min(img.height - 1, int(y * sy))
        for x in range(width):
            sxi = min(img.width - 1, int(x * sx))
            src = (syi * img.width + sxi) * ch
            dst = (y * width + x) * ch
            out[dst:dst + ch] = img.pixels[src:src + ch]
    return Image(width, height, out, img.mode)


def _gray(img: Image) -> Image:
    rgb = img.to_rgb()
    out = bytearray(img.width * img.height)
    for i in range(img.width * img.height):
        r, g, b = rgb.pixels[i * 3], rgb.pixels[i * 3 + 1], rgb.pixels[i * 3 + 2]
        out[i] = (r * 299 + g * 587 + b * 114) // 1000
    return Image(img.width, img.height, out, "L")


def _flip(img: Image, mode: str) -> Image:
    ch = img.channels
    w, h = img.width, img.height
    out = bytearray(len(img.pixels))
    for y in range(h):
        for x in range(w):
            sx = w - 1 - x if mode in ("horizontal", "both") else x
            sy = h - 1 - y if mode in ("vertical", "both") else y
            src = (sy * w + sx) * ch
            dst = (y * w + x) * ch
            out[dst:dst + ch] = img.pixels[src:src + ch]
    return Image(w, h, out, img.mode)


def _rotate90(img: Image, turns: int) -> Image:
    turns %= 4
    if turns == 0:
        return img
    ch = img.channels
    w, h = img.width, img.height
    if turns == 2:
        out = bytearray(len(img.pixels))
        for y in range(h):
            for x in range(w):
                src = (y * w + x) * ch
                dst = ((h - 1 - y) * w + (w - 1 - x)) * ch
                out[dst:dst + ch] = img.pixels[src:src + ch]
        return Image(w, h, out, img.mode)
    nw, nh = h, w
    out = bytearray(nw * nh * ch)
    for y in range(h):
        for x in range(w):
            src = (y * w + x) * ch
            if turns == 1:      # 逆时针 90°
                nx, ny = y, h - 1 - x if False else w - 1 - x
                nx, ny = y, w - 1 - x
            else:               # 顺时针 90°
                nx, ny = h - 1 - y, x
            dst = (ny * nw + nx) * ch
            out[dst:dst + ch] = img.pixels[src:src + ch]
    return Image(nw, nh, out, img.mode)


def _apply_transforms(img: Image, params: dict) -> tuple[Image, bool]:
    changed = False

    if bool(params.get("grayscale")):
        img = _gray(img)
        changed = True

    rotate = float(params.get("rotate") or 0)
    if rotate:
        turns = int(round(rotate / 90.0)) % 4
        img = _rotate90(img, turns)
        changed = True

    flip = str(params.get("flip") or "none").lower()
    if flip in ("horizontal", "vertical", "both"):
        img = _flip(img, flip)
        changed = True

    tw = int(params.get("resize_w") or 0)
    th = int(params.get("resize_h") or 0)
    if tw > 0 or th > 0:
        keep = bool(params.get("keep_aspect", True))
        if keep:
            if tw > 0 and th > 0:
                ratio = min(tw / img.width, th / img.height)
            elif tw > 0:
                ratio = tw / img.width
            else:
                ratio = th / img.height
            target = (max(1, round(img.width * ratio)), max(1, round(img.height * ratio)))
        else:
            target = (tw or img.width, th or img.height)
        if target != (img.width, img.height):
            img = _nearest_resize(img, *target)
            changed = True

    return img, changed


def main(argv=None) -> int:
    app = KernelApp(KERNEL_ID, VERSION, engine=ENGINE)

    def handler(job, _app):
        op = str(job.get("op", "convert"))
        if op not in ("convert", "transform", "optimize"):
            raise CkpError("UNSUPPORTED_FORMAT",
                           f"纯标准库内核只支持 convert/transform/optimize，收到 {op}")

        inputs = [i["path"] for i in job.get("inputs") or []]
        outputs = job.get("outputs") or []
        if not inputs or not outputs:
            raise CkpError("BAD_JOB", "需要至少一个输入与输出")

        src = inputs[0]
        dst = outputs[0]["path"]
        out_fmt = canonical_format(outputs[0].get("format") or format_of_path(dst))
        if out_fmt not in SUPPORTED:
            raise CkpError(
                "UNSUPPORTED_FORMAT",
                f"纯标准库内核不支持写出 '{out_fmt}'，"
                f"可用：{', '.join(SUPPORTED)}。请改用 pillow-image 内核。")
        ensure_parent(dst)

        params = dict(job.get("params") or {})
        in_fmt = canonical_format(
            str((job.get("inputs") or [{}])[0].get("format") or "") or format_of_path(src))
        _app.progress(0.2, "解码中")
        try:
            img = codecs_std.read_image(src, in_fmt)
        except CodecError as exc:
            raise CkpError("INPUT_UNREADABLE", str(exc)) from exc
        except FileNotFoundError as exc:
            raise CkpError("INPUT_NOT_FOUND", f"输入文件不存在: {src}") from exc

        _app.log(f"{img.width}x{img.height} mode={img.mode}")

        _app.progress(0.5, "变换中")
        img, _changed = _apply_transforms(img, params)

        _app.progress(0.75, "编码中")
        try:
            codecs_std.write_image(img, dst, out_fmt, params)
        except CodecError as exc:
            raise CkpError("UNSUPPORTED_FORMAT", str(exc)) from exc
        except OSError as exc:
            raise CkpError("OUTPUT_NOT_WRITABLE", f"写入失败: {exc}") from exc

        meta = {"width": img.width, "height": img.height, "mode": img.mode,
                "engine": ENGINE}
        return [emit_artifact(dst, out_fmt, primary=True, meta=meta)]

    return app.run(handler, argv)


if __name__ == "__main__":
    raise SystemExit(main())
