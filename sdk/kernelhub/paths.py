"""项目路径解析、vendor 依赖注入与用户配置。

宿主启动时第一件事就是调用 :func:`bootstrap`：它把 ``vendor/`` 加入 ``sys.path``，
确保 PyPI 侧内核依赖（Pillow / PyMuPDF / imageio-ffmpeg …）可被导入。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

# --------------------------------------------------------------------------- #
# 路径
# --------------------------------------------------------------------------- #

#: kernelhub/ 包的上一级 = 项目根（kernel-hub/）
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

VENDOR_DIR = os.path.join(PROJECT_ROOT, "vendor")
PLUGINS_DIR = os.path.join(PROJECT_ROOT, "plugins")
TOOLS_DIR = os.path.join(PROJECT_ROOT, "tools")
DOCS_DIR = os.path.join(PROJECT_ROOT, "docs")
SCHEMA_DIR = os.path.join(PROJECT_ROOT, "protocol", "schemas")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "output")
CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")

#: 用户级配置目录（跨项目共享内核开关）
USER_HOME = os.path.join(os.path.expanduser("~"), ".kernelhub")
USER_PLUGIN_DIR = os.path.join(USER_HOME, "plugins")
CONFIG_PATH = os.path.join(USER_HOME, "config.json")

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "disabled_kernels": [],
    "priority_overrides": {},
    "extra_plugin_dirs": [],
    "last_output_dir": "",
    "locale": "zh-CN",
    "theme": "dark",
}


def ensure_dir(path: str) -> str:
    """确保目录存在（使用默认模式，规避沙箱下 0o700 不可写的问题）。"""
    if path and not os.path.isdir(path):
        os.makedirs(path, exist_ok=True)
    return path


def bootstrap(verbose: bool = False) -> list[str]:
    """把项目根与 vendor 目录注入 ``sys.path``，返回实际注入的路径。

    项目根必须在 ``sys.path`` 中，适配器才能 ``from kernelhub.sdk import ...``。
    """
    added: list[str] = []
    for path in (VENDOR_DIR, PROJECT_ROOT):
        if os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)
            added.append(path)
    if verbose and added:
        for p in added:
            print(f"[paths] sys.path += {p}", file=sys.stderr)
    return added


def plugin_search_paths() -> list[str]:
    """返回内核搜索路径（去重、保序）。"""
    paths: list[str] = [PLUGINS_DIR]

    env = os.environ.get("CKP_PLUGIN_PATH", "")
    for item in env.split(os.pathsep):
        item = item.strip()
        if item:
            paths.append(os.path.abspath(item))

    cfg = load_config()
    for item in cfg.get("extra_plugin_dirs", []) or []:
        if isinstance(item, str) and item.strip():
            paths.append(os.path.abspath(item.strip()))

    if os.path.isdir(USER_PLUGIN_DIR):
        paths.append(USER_PLUGIN_DIR)

    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        norm = os.path.normcase(os.path.abspath(p))
        if norm not in seen:
            seen.add(norm)
            out.append(os.path.abspath(p))
    return out


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #


def load_config() -> dict[str, Any]:
    """读取用户配置；缺失或损坏时返回默认配置。"""
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            cfg.update(data)
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg: dict[str, Any]) -> bool:
    """写入用户配置，返回是否成功。"""
    try:
        ensure_dir(USER_HOME)
        with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
        return True
    except OSError:
        return False


def python_executable() -> str:
    """当前宿主使用的 Python 解释器绝对路径。"""
    return os.path.abspath(sys.executable)


def describe_layout() -> dict[str, str]:
    return {
        "project_root": PROJECT_ROOT,
        "vendor": VENDOR_DIR,
        "plugins": PLUGINS_DIR,
        "output": OUTPUT_DIR,
        "user_home": USER_HOME,
        "config": CONFIG_PATH,
        "python": python_executable(),
    }
