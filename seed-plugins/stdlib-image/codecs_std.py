"""纯标准库图像编解码器 —— 零第三方依赖。

支持读写：PNG（8 位灰度/RGB/调色板/灰度+Alpha/RGBA，非隔行）、
BMP（1/4/8/24/32 位）、Netpbm（P1–P6）、TGA（未压缩与 RLE）。

这是 KernelHub 的「兜底内核」：即使机器上什么都没装，png/jpg 之外的基础
位图互转依然可用。所有实现仅依赖 ``zlib`` 与 ``struct``。
"""

from __future__ import annotations

import struct
import zlib

__all__ = ["Image", "read_image", "write_image", "sniff_format", "CodecError"]


class CodecError(Exception):
    """解码/编码失败。"""


class Image:
    """极简内存位图：8 位 RGB 或 RGBA。"""

    __slots__ = ("width", "height", "pixels", "mode")

    def __init__(self, width: int, height: int, pixels: bytearray, mode: str = "RGB"):
        self.width = int(width)
        self.height = int(height)
        self.pixels = pixels
        self.mode = mode.upper()

    @property
    def channels(self) -> int:
        return 4 if self.mode == "RGBA" else (1 if self.mode == "L" else 3)

    def to_rgb(self, background: tuple[int, int, int] = (255, 255, 255)) -> "Image":
        if self.mode == "RGB":
            return self
        if self.mode == "L":
            out = bytearray(self.width * self.height * 3)
            for i, v in enumerate(self.pixels):
                out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v
            return Image(self.width, self.height, out, "RGB")
        if self.mode == "RGBA":
            out = bytearray(self.width * self.height * 3)
            br, bg, bb = background
            for i in range(self.width * self.height):
                a = self.pixels[i * 4 + 3]
                if a == 255:
                    out[i * 3] = self.pixels[i * 4]
                    out[i * 3 + 1] = self.pixels[i * 4 + 1]
                    out[i * 3 + 2] = self.pixels[i * 4 + 2]
                elif a == 0:
                    out[i * 3] = br
                    out[i * 3 + 1] = bg
                    out[i * 3 + 2] = bb
                else:
                    inv = 255 - a
                    out[i * 3] = (self.pixels[i * 4] * a + br * inv) // 255
                    out[i * 3 + 1] = (self.pixels[i * 4 + 1] * a + bg * inv) // 255
                    out[i * 3 + 2] = (self.pixels[i * 4 + 2] * a + bb * inv) // 255
            return Image(self.width, self.height, out, "RGB")
        raise CodecError(f"不支持的颜色模式: {self.mode}")


# --------------------------------------------------------------------------- #
# 格式嗅探
# --------------------------------------------------------------------------- #

_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"BM", "bmp"),
    (b"GIF8", "gif"),
    (b"\xff\xd8\xff", "jpg"),
)


def sniff_format(data: bytes) -> str:
    for sig, name in _SIGNATURES:
        if data.startswith(sig):
            return name
    if len(data) > 2 and data[0:1] == b"P" and data[1:2] in b"123456":
        return "pnm"
    return ""


# --------------------------------------------------------------------------- #
# PNG
# --------------------------------------------------------------------------- #


def _png_unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytearray:
    stride = width * bpp
    out = bytearray(stride * height)
    pos = 0
    prev = bytearray(stride)
    for y in range(height):
        if pos >= len(raw):
            raise CodecError("PNG 数据不足")
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        if len(line) < stride:
            raise CodecError("PNG 行数据不足")
        pos += stride
        if ftype == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ftype != 0:
            raise CodecError(f"未知 PNG 过滤器类型 {ftype}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


def read_png(data: bytes) -> Image:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise CodecError("不是 PNG 文件")
    pos = 8
    idat = bytearray()
    palette: bytes | None = None
    trns: bytes | None = None
    width = height = bit_depth = color_type = interlace = 0

    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], "big")
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            (width, height, bit_depth, color_type,
             _comp, _filt, interlace) = struct.unpack(">IIBBBBB", chunk[:13])
        elif ctype == b"PLTE":
            palette = chunk
        elif ctype == b"tRNS":
            trns = chunk
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break

    if interlace:
        raise CodecError("暂不支持隔行扫描（Adam7）PNG")
    if bit_depth not in (1, 2, 4, 8, 16):
        raise CodecError(f"暂不支持 {bit_depth} 位深 PNG")

    raw = zlib.decompress(bytes(idat))

    # 先算出每像素字节数（16 位按 2 字节算）
    if color_type == 0:
        chans = 1
    elif color_type == 2:
        chans = 3
    elif color_type == 3:
        chans = 1
    elif color_type == 4:
        chans = 2
    elif color_type == 6:
        chans = 4
    else:
        raise CodecError(f"未知 PNG 颜色类型 {color_type}")

    bits_per_pixel = chans * bit_depth
    bpp = max(1, bits_per_pixel // 8)

    if bit_depth == 8:
        flat = _png_unfilter(raw, width, height, chans)
    elif bit_depth == 16:
        flat16 = _png_unfilter(raw, width, height, chans * 2)
        flat = bytearray(width * height * chans)
        for i in range(width * height * chans):
            flat[i] = flat16[i * 2]
    else:
        # 低位深：逐位解包成 8 位采样
        stride_bits = width * bits_per_pixel
        stride_bytes = (stride_bits + 7) // 8
        unpacked = _png_unfilter(raw, stride_bytes, height, 1)
        per_byte = 8 // bit_depth
        mask = (1 << bit_depth) - 1
        flat = bytearray(width * height * chans)
        for y in range(height):
            row = unpacked[y * stride_bytes:(y + 1) * stride_bytes]
            for x in range(width):
                byte = row[x // per_byte]
                shift = 8 - bit_depth * ((x % per_byte) + 1)
                value = (byte >> shift) & mask
                flat[(y * width + x) * chans] = value * (255 // mask)

    # 统一成 L / RGB / RGBA
    if color_type == 0:
        return Image(width, height, flat, "L")
    if color_type == 4:
        gray = bytearray(width * height)
        alpha = bytearray(width * height)
        for i in range(width * height):
            gray[i] = flat[i * 2]
            alpha[i] = flat[i * 2 + 1]
        out = bytearray(width * height * 4)
        for i in range(width * height):
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = gray[i]
            out[i * 4 + 3] = alpha[i]
        return Image(width, height, out, "RGBA")
    if color_type == 2:
        return Image(width, height, flat, "RGB")
    if color_type == 6:
        return Image(width, height, flat, "RGBA")

    # color_type == 3：调色板
    if not palette:
        raise CodecError("调色板 PNG 缺少 PLTE")
    out = bytearray(width * height * 4)
    for i in range(width * height):
        idx = flat[i]
        if idx * 3 + 2 >= len(palette):
            raise CodecError("PNG 调色板索引越界")
        out[i * 4] = palette[idx * 3]
        out[i * 4 + 1] = palette[idx * 3 + 1]
        out[i * 4 + 2] = palette[idx * 3 + 2]
        out[i * 4 + 3] = trns[idx] if trns and idx < len(trns) else 255
    return Image(width, height, out, "RGBA")


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload)) + tag + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))


def _png_filter_row(line: bytes, prev: bytes | None, bpp: int) -> tuple[int, bytearray]:
    """按「绝对值和最小」启发式挑一个最好的行过滤器（比全 0 小一个数量级）。"""
    stride = len(line)
    best_score = None
    best_type = 0
    best_out = bytearray(line)
    for ftype in range(5):
        out = bytearray(stride)
        for i in range(stride):
            x = line[i]
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i] if prev is not None else 0
            c = prev[i - bpp] if (prev is not None and i >= bpp) else 0
            if ftype == 0:
                v = x
            elif ftype == 1:
                v = x - a
            elif ftype == 2:
                v = x - b
            elif ftype == 3:
                v = x - ((a + b) >> 1)
            else:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                v = x - pr
            out[i] = v & 0xFF
        score = 0
        for v in out:
            score += v if v < 128 else 256 - v
        if best_score is None or score < best_score:
            best_score = score
            best_type = ftype
            best_out = out
    return best_type, best_out


def write_png(img: Image, level: int = 6, background=(255, 255, 255),
              preserve_alpha: bool = True) -> bytes:
    """写出 8 位 PNG。RGBA 源默认保留透明通道（颜色类型 6），否则转 RGB。"""
    if img.mode == "RGBA" and preserve_alpha:
        data = bytes(img.pixels)
        bpp = 4
        color_type = 6
    else:
        rgb = img.to_rgb(background)
        data = bytes(rgb.pixels)
        bpp = 3
        color_type = 2

    width, height = img.width, img.height
    stride = width * bpp
    raw = bytearray()
    prev: bytes | None = None
    for y in range(height):
        line = data[y * stride:(y + 1) * stride]
        ftype, filtered = _png_filter_row(line, prev, bpp)
        raw.append(ftype)
        raw += filtered
        prev = line

    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", header)
            + _png_chunk(b"IDAT", zlib.compress(bytes(raw), max(0, min(9, level))))
            + _png_chunk(b"IEND", b""))


# --------------------------------------------------------------------------- #
# BMP
# --------------------------------------------------------------------------- #


def read_bmp(data: bytes) -> Image:
    if data[:2] != b"BM":
        raise CodecError("不是 BMP 文件")
    data_offset = struct.unpack_from("<I", data, 10)[0]
    header_size = struct.unpack_from("<I", data, 14)[0]
    if header_size < 40:
        raise CodecError("暂不支持 OS/2 格式 BMP")

    width, raw_height = struct.unpack_from("<ii", data, 18)
    planes, bpp = struct.unpack_from("<HH", data, 26)
    compression = struct.unpack_from("<I", data, 30)[0]
    top_down = raw_height < 0
    height = abs(raw_height)

    if compression not in (0, 3):
        raise CodecError(f"暂不支持压缩方式 {compression} 的 BMP")
    if bpp not in (1, 4, 8, 24, 32):
        raise CodecError(f"暂不支持 {bpp} 位 BMP")

    palette: list[tuple[int, int, int]] = []
    if bpp <= 8:
        count = struct.unpack_from("<I", data, 46)[0] or (1 << bpp)
        base = 14 + header_size
        for i in range(count):
            b, g, r, _ = struct.unpack_from("<BBBB", data, base + i * 4)
            palette.append((r, g, b))

    row_size = ((bpp * width + 31) // 32) * 4
    out = bytearray(width * height * 4)

    for y in range(height):
        src_y = y if top_down else (height - 1 - y)
        row = data[data_offset + src_y * row_size: data_offset + (src_y + 1) * row_size]
        for x in range(width):
            if bpp == 24:
                b, g, r = row[x * 3], row[x * 3 + 1], row[x * 3 + 2]
                a = 255
            elif bpp == 32:
                b, g, r, a = row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]
                if a == 0 and compression == 0:
                    a = 255
            elif bpp == 8:
                idx = row[x]
                r, g, b = palette[idx] if idx < len(palette) else (0, 0, 0)
                a = 255
            elif bpp == 4:
                byte = row[x // 2]
                idx = (byte >> 4) if x % 2 == 0 else (byte & 0x0F)
                r, g, b = palette[idx] if idx < len(palette) else (0, 0, 0)
                a = 255
            else:  # bpp == 1
                byte = row[x // 8]
                idx = (byte >> (7 - x % 8)) & 1
                r, g, b = palette[idx] if idx < len(palette) else (0, 0, 0)
                a = 255
            i = (y * width + x) * 4
            out[i], out[i + 1], out[i + 2], out[i + 3] = r, g, b, a

    return Image(width, height, out, "RGBA")


def write_bmp(img: Image, background=(255, 255, 255)) -> bytes:
    rgb = img.to_rgb(background)
    width, height = rgb.width, rgb.height
    row_size = ((24 * width + 31) // 32) * 4
    pixel_bytes = row_size * height
    header = struct.pack("<2sIHHI", b"BM", 14 + 40 + pixel_bytes, 0, 0, 14 + 40)
    info = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, pixel_bytes,
                       2835, 2835, 0, 0)
    body = bytearray()
    for y in range(height - 1, -1, -1):  # BMP 自下而上
        row = bytearray()
        base = y * width * 3
        for x in range(width):
            r = rgb.pixels[base + x * 3]
            g = rgb.pixels[base + x * 3 + 1]
            b = rgb.pixels[base + x * 3 + 2]
            row += bytes((b, g, r))
        row += b"\x00" * (row_size - len(row))
        body += row
    return header + info + bytes(body)


# --------------------------------------------------------------------------- #
# Netpbm (P1..P6)
# --------------------------------------------------------------------------- #


def _pnm_tokens(data: bytes):
    tokens: list[bytes] = []
    i = 0
    n = len(data)
    while i < n and len(tokens) < 4:
        while i < n and data[i:i + 1].isspace():
            i += 1
        if data[i:i + 1] == b"#":
            while i < n and data[i:i + 1] not in (b"\n", b"\r"):
                i += 1
            continue
        start = i
        while i < n and not data[i:i + 1].isspace():
            i += 1
        tokens.append(data[start:i])
    return tokens, i


def read_pnm(data: bytes) -> Image:
    tokens, offset = _pnm_tokens(data)
    if len(tokens) < 3:
        raise CodecError("PNM 头不完整")
    magic = tokens[0].decode("ascii", "replace")
    if magic not in ("P1", "P2", "P3", "P4", "P5", "P6"):
        raise CodecError(f"未知 PNM 魔数 {magic}")
    width = int(tokens[1])
    height = int(tokens[2])
    maxval = int(tokens[3]) if len(tokens) > 3 else 1

    if magic in ("P1", "P4"):
        maxval = 1
        offset = _skip_whitespace_once(data, offset)

    if magic in ("P4", "P5", "P6"):
        binary = data[offset:]
        if binary[:1].isspace():
            binary = binary[1:]
    else:
        binary = b""

    out = bytearray(width * height * 4)

    if magic in ("P1", "P2", "P3"):
        values = data[offset:].split()
        idx = 0
        for p in range(width * height):
            if magic == "P1":
                v = 0 if values[idx] == b"1" else 255
                idx += 1
                r = g = b = v
            elif magic == "P2":
                v = int(values[idx]) * 255 // max(1, maxval)
                idx += 1
                r = g = b = v
            else:
                r = int(values[idx]) * 255 // max(1, maxval)
                g = int(values[idx + 1]) * 255 // max(1, maxval)
                b = int(values[idx + 2]) * 255 // max(1, maxval)
                idx += 3
            i = p * 4
            out[i], out[i + 1], out[i + 2], out[i + 3] = r, g, b, 255
    elif magic == "P4":
        stride = (width + 7) // 8
        for y in range(height):
            row = binary[y * stride:(y + 1) * stride]
            for x in range(width):
                bit = (row[x // 8] >> (7 - x % 8)) & 1
                v = 0 if bit else 255
                i = (y * width + x) * 4
                out[i], out[i + 1], out[i + 2], out[i + 3] = v, v, v, 255
    elif magic == "P5":
        bytes_per = 2 if maxval > 255 else 1
        for p in range(width * height):
            raw = binary[p * bytes_per]
            if bytes_per == 2:
                raw = binary[p * 2]
            v = raw * 255 // max(1, maxval) if maxval != 255 else raw
            i = p * 4
            out[i], out[i + 1], out[i + 2], out[i + 3] = v, v, v, 255
    else:  # P6
        bytes_per = 2 if maxval > 255 else 1
        for p in range(width * height):
            base = p * 3 * bytes_per
            r, g, b = binary[base], binary[base + bytes_per], binary[base + 2 * bytes_per]
            if maxval != 255:
                r = r * 255 // maxval
                g = g * 255 // maxval
                b = b * 255 // maxval
            i = p * 4
            out[i], out[i + 1], out[i + 2], out[i + 3] = r, g, b, 255

    return Image(width, height, out, "RGBA")


def _skip_whitespace_once(data: bytes, offset: int) -> int:
    if offset < len(data) and data[offset:offset + 1].isspace():
        return offset + 1
    return offset


def write_pnm(img: Image, fmt: str, background=(255, 255, 255)) -> bytes:
    fmt = fmt.lower()
    if fmt in ("pgm", "pbm"):
        gray = img.to_rgb(background)
        data = bytearray()
        for i in range(gray.width * gray.height):
            r, g, b = (gray.pixels[i * 3], gray.pixels[i * 3 + 1], gray.pixels[i * 3 + 2])
            data.append((r * 299 + g * 587 + b * 114) // 1000)
        if fmt == "pgm":
            head = f"P5\n{gray.width} {gray.height}\n255\n".encode("ascii")
            return head + bytes(data)
        head = f"P4\n{gray.width} {gray.height}\n".encode("ascii")
        stride = (gray.width + 7) // 8
        body = bytearray(stride * gray.height)
        for y in range(gray.height):
            for x in range(gray.width):
                if data[y * gray.width + x] < 128:
                    body[y * stride + x // 8] |= 1 << (7 - x % 8)
        return head + bytes(body)

    rgb = img.to_rgb(background)
    if fmt == "ppm":
        head = f"P6\n{rgb.width} {rgb.height}\n255\n".encode("ascii")
        return head + bytes(rgb.pixels)
    if fmt == "pnm":
        head = f"P6\n{rgb.width} {rgb.height}\n255\n".encode("ascii")
        return head + bytes(rgb.pixels)
    raise CodecError(f"不支持的 Netpbm 输出格式: {fmt}")


# --------------------------------------------------------------------------- #
# TGA
# --------------------------------------------------------------------------- #


def read_tga(data: bytes) -> Image:
    if len(data) < 18:
        raise CodecError("TGA 头不完整")
    id_len, cmap_type, img_type = data[0], data[1], data[2]
    width, height, bpp, descriptor = struct.unpack_from("<HHBB", data, 12)
    if cmap_type != 0:
        raise CodecError("暂不支持带调色板的 TGA")
    if img_type not in (2, 3, 10, 11):
        raise CodecError(f"暂不支持 TGA 类型 {img_type}")

    pos = 18 + id_len
    n_chan = bpp // 8
    total = width * height
    pixels = bytearray()

    if img_type in (10, 11):  # RLE
        while len(pixels) < total * n_chan:
            header = data[pos]
            pos += 1
            count = (header & 0x7F) + 1
            if header & 0x80:
                value = data[pos:pos + n_chan]
                pos += n_chan
                pixels += value * count
            else:
                pixels += data[pos:pos + count * n_chan]
                pos += count * n_chan
    else:
        pixels = bytearray(data[pos:pos + total * n_chan])

    out = bytearray(total * 4)
    for p in range(total):
        base = p * n_chan
        b = pixels[base]
        g = pixels[base + 1] if n_chan >= 3 else b
        r = pixels[base + 2] if n_chan >= 3 else b
        a = pixels[base + 3] if n_chan == 4 else 255
        i = p * 4
        out[i], out[i + 1], out[i + 2], out[i + 3] = r, g, b, a

    img = Image(width, height, out, "RGBA")
    if not (descriptor & 0x20):  # 默认自下而上
        flipped = bytearray(len(out))
        stride = width * 4
        for y in range(height):
            flipped[y * stride:(y + 1) * stride] = out[(height - 1 - y) * stride:(height - y) * stride]
        img.pixels = flipped
    return img


def write_tga(img: Image, background=(255, 255, 255)) -> bytes:
    rgb = img.to_rgb(background)
    width, height = rgb.width, rgb.height
    header = struct.pack("<BBBHHBHHHHBB", 0, 0, 2, 0, 0, 0, 0, 0, width, height,
                         24, 0x20)
    body = bytearray()
    for i in range(width * height):
        r = rgb.pixels[i * 3]
        g = rgb.pixels[i * 3 + 1]
        b = rgb.pixels[i * 3 + 2]
        body += bytes((b, g, r))
    return header + bytes(body)


# --------------------------------------------------------------------------- #
# 统一入口
# --------------------------------------------------------------------------- #

READERS = {
    "png": read_png,
    "bmp": read_bmp,
    "ppm": read_pnm,
    "pgm": read_pnm,
    "pbm": read_pnm,
    "pnm": read_pnm,
    "tga": read_tga,
}

WRITERS = {
    "png": write_png,
    "bmp": write_bmp,
    "ppm": write_pnm,
    "pgm": write_pnm,
    "pbm": write_pnm,
    "pnm": write_pnm,
    "tga": write_tga,
}


def read_image(path: str, fmt: str = "") -> Image:
    with open(path, "rb") as fh:
        data = fh.read()
    fmt = (fmt or "").lower()
    if fmt not in READERS:
        fmt = sniff_format(data)
    if fmt == "pnm":
        magic = data[:2]
        fmt = {"P1": "pbm", "P2": "pgm", "P3": "ppm",
               "P4": "pbm", "P5": "pgm", "P6": "ppm"}.get(
            magic.decode("ascii", "replace"), "ppm")
    reader = READERS.get(fmt)
    if reader is None:
        raise CodecError(
            f"纯标准库内核不支持读取 {fmt or '未知'} 格式"
            "（支持 png / bmp / ppm / pgm / pbm / pnm / tga）")
    return reader(data)


def write_image(img: Image, path: str, fmt: str, params: dict | None = None) -> None:
    params = params or {}
    fmt = (fmt or "").lower()
    writer = WRITERS.get(fmt)
    if writer is None:
        raise CodecError(
            f"纯标准库内核不支持写出 {fmt or '未知'} 格式"
            "（支持 png / bmp / ppm / pgm / pbm / pnm / tga）")
    background = _parse_rgb(params.get("background"))
    if fmt == "png":
        payload = writer(img, level=int(params.get("png_compress_level") or 6),
                         background=background)
    else:
        payload = writer(img, background=background)
    with open(path, "wb") as fh:
        fh.write(payload)


def _parse_rgb(value) -> tuple[int, int, int]:
    text = str(value or "").strip()
    if text.startswith("#") and len(text) >= 7:
        try:
            return (int(text[1:3], 16), int(text[3:5], 16), int(text[5:7], 16))
        except ValueError:
            return (255, 255, 255)
    return (255, 255, 255)
