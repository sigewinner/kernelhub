"""KernelHub —— 基于 CKP 协议的格式转换内核中枢。

宿主侧核心（纯标准库，零第三方依赖）：

* :mod:`kernelhub.protocol`  —— CKP 1.0 常量、归一化与校验
* :mod:`kernelhub.paths`     —— 项目路径与 vendor 依赖注入
* :mod:`kernelhub.registry`  —— 内核发现、清单校验、能力索引
* :mod:`kernelhub.runner`    —— 子进程桥接与 NDJSON 事件流解析
* :mod:`kernelhub.jobs`      —— 任务编排（单次 / 批量）
* :mod:`kernelhub.cli`       —— 命令行入口
* :mod:`kernelhub.gui`       —— Tkinter 图形界面
"""

from __future__ import annotations

__version__ = "1.0.0"
__protocol__ = "1.0"

#: 导入 kernelhub 即完成依赖注入：把 vendor/ 与项目根加入 sys.path。
#: 这一步必须早于任何内核探测（注册表用 importlib.util.find_spec 判断依赖是否就绪）。
from kernelhub import paths as _paths  # noqa: E402

_paths.bootstrap()

__all__ = ["__version__", "__protocol__", "_paths"]
