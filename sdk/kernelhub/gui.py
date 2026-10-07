"""KernelHub 图形界面 —— 基于 Tkinter 的原生桌面工具（零第三方 GUI 依赖）。

界面结构::

    ┌───────────────────────────────────────────────────────────────┐
    │ 工具栏：刷新内核 | 添加文件 | 添加目录 | 清空 | 输出目录 | 主题 │
    ├──────────────┬────────────────────────────────────────────────┤
    │ 内核列表      │  [转换]  [内核详情]  [协议]                     │
    │ (状态/能力)   │  文件队列                                      │
    │              │  操作 / 目标格式 / 内核选择                     │
    │              │  参数面板（由内核清单自动生成）                  │
    │              │  进度条 + 日志                                  │
    ├──────────────┴────────────────────────────────────────────────┤
    │ 状态栏：内核数 / 任务数 / 当前内核                              │
    └───────────────────────────────────────────────────────────────┘

设计要点：

* **参数面板完全由 CKP 清单驱动** —— 内核声明什么参数，界面就长出什么控件，
  宿主代码里没有任何一个格式或参数是写死的。
* 转换跑在后台线程，UI 通过队列刷新，绝不阻塞主循环。
* 内核状态（可用/依赖缺失/未安装/已停用）实时展示，并给出安装命令。
"""

from __future__ import annotations

import os
import queue
import sys
import threading
import time
import tkinter as tk
import traceback
from tkinter import colorchooser, filedialog, messagebox, ttk
from typing import Any, Callable

from kernelhub import __version__, paths
from kernelhub.jobs import ConvertRequest, Hub, default_output_path
from kernelhub.protocol import (
    CKP_VERSION,
    ParamSpec,
    STATUS_LABELS_ZH,
    canonical_format,
    format_of_path,
    merge_params,
)

APP_TITLE = f"KernelHub · 格式转换内核中枢  v{__version__}  (CKP {CKP_VERSION})"

STATUS_GLYPH = {
    "ready": "●",
    "degraded": "◐",
    "unavailable": "○",
    "invalid": "✕",
    "disabled": "–",
}

#: 各状态下的文字颜色（浅色主题）
STATUS_FG = {
    "ready": "#1a7f37",
    "degraded": "#b26a00",
    "unavailable": "#8a8a8a",
    "invalid": "#c0392b",
    "disabled": "#9a9a9a",
}

FONT_UI = ("Microsoft YaHei UI", 9) if os.name == "nt" else ("Helvetica", 10)
FONT_MONO = ("Consolas", 9) if os.name == "nt" else ("Courier", 10)


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #


def human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num) < 1024 or unit == "GB":
            return f"{num:,.0f} {unit}" if unit == "B" else f"{num:,.1f} {unit}"
        num /= 1024.0
    return f"{num:.1f} GB"


class ScrollFrame(ttk.Frame):
    """带垂直滚动条的容器，内部用 ``.body`` 放控件。"""

    def __init__(self, master: tk.Misc, **kw: Any) -> None:
        super().__init__(master, **kw)
        self.canvas = tk.Canvas(self, highlightthickness=0, borderwidth=0)
        self.scroll = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.body = ttk.Frame(self.canvas)
        self._window = self.canvas.create_window((0, 0), window=self.body, anchor="nw")
        self.canvas.configure(yscrollcommand=self.scroll.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.scroll.grid(row=0, column=1, sticky="ns")
        self.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.body.bind("<Configure>", self._on_body_configure)
        self.canvas.bind("<Configure>", self._on_canvas_configure)
        self.canvas.bind_all("<MouseWheel>", self._on_wheel, add="+")

    def _on_body_configure(self, _event: tk.Event) -> None:
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_canvas_configure(self, event: tk.Event) -> None:
        self.canvas.itemconfigure(self._window, width=event.width)

    def _on_wheel(self, event: tk.Event) -> None:
        try:
            if self.canvas.winfo_exists() and self.winfo_ismapped():
                self.canvas.yview_scroll(int(-event.delta / 120), "units")
        except tk.TclError:
            pass


# --------------------------------------------------------------------------- #
# 参数面板（协议驱动，自动生成控件）
# --------------------------------------------------------------------------- #


class ParamPanel(ttk.Frame):
    """由内核清单的 ``params`` 自动生成输入控件。"""

    def __init__(self, master: tk.Misc, on_change: Callable[[], None] | None = None) -> None:
        super().__init__(master)
        self._vars: dict[str, tk.Variable] = {}
        self._specs: dict[str, ParamSpec] = {}
        self._widgets: list[tk.Widget] = []
        self._on_change = on_change

        head = ttk.Frame(self)
        head.pack(fill="x", padx=2, pady=(0, 4))
        self.title = ttk.Label(head, text="参数", font=(FONT_UI[0], 9, "bold"))
        self.title.pack(side="left")
        self.hint = ttk.Label(head, text="（由内核清单自动生成）", foreground="#888888")
        self.hint.pack(side="left", padx=(6, 0))

        self.area = ScrollFrame(self, height=190)
        self.area.pack(fill="both", expand=True)

    # -- 构建 --------------------------------------------------------------- #

    def rebuild(self, specs: list[ParamSpec], op: str, src_fmt: str, dst_fmt: str) -> None:
        for child in self.area.body.winfo_children():
            child.destroy()
        self._vars.clear()
        self._specs.clear()
        self._widgets.clear()

        visible = [s for s in specs if s.visible_for(op, src_fmt, dst_fmt)]
        basic = [s for s in visible if not s.advanced]
        advanced = [s for s in visible if s.advanced]

        if not visible:
            ttk.Label(self.area.body, text="当前组合无需参数",
                      foreground="#888888").grid(row=0, column=0, sticky="w", padx=6, pady=6)
            self.title.configure(text="参数（0）")
            return

        row = 0
        for spec in basic:
            row = self._add_control(self.area.body, row, spec)

        if advanced:
            self._adv_open = tk.BooleanVar(value=False)
            toggle = ttk.Checkbutton(self.area.body, text=f"高级参数（{len(advanced)}）",
                                     variable=self._adv_open,
                                     command=lambda: self._toggle_advanced(advanced))
            toggle.grid(row=row, column=0, columnspan=3, sticky="w", padx=6, pady=(8, 2))
            row += 1
            self._adv_frame = ttk.Frame(self.area.body)
            self._adv_frame.grid(row=row, column=0, columnspan=3, sticky="ew")
            self._adv_frame.grid_remove()
            self._adv_rows = advanced
            self._adv_row_index = row
            self._adv_built = False

        self.title.configure(text=f"参数（{len(visible)}）")

    def _toggle_advanced(self, specs: list[ParamSpec]) -> None:
        if self._adv_open.get():
            if not getattr(self, "_adv_built", False):
                row = 0
                for spec in specs:
                    row = self._add_control(self._adv_frame, row, spec)
                self._adv_built = True
            self._adv_frame.grid()
        else:
            self._adv_frame.grid_remove()

    def _add_control(self, parent: tk.Misc, row: int, spec: ParamSpec) -> int:
        label = ttk.Label(parent, text=spec.label or spec.id, width=18, anchor="w")
        label.grid(row=row, column=0, sticky="w", padx=(6, 4), pady=3)

        var, widget = self._make_widget(parent, spec)
        self._vars[spec.id] = var
        self._specs[spec.id] = spec
        self._widgets.append(widget)
        widget.grid(row=row, column=1, sticky="ew", padx=(0, 6), pady=3)
        parent.columnconfigure(1, weight=1)

        if spec.description:
            ttk.Label(parent, text=spec.description, foreground="#888888",
                      font=(FONT_UI[0], 8)).grid(row=row, column=2, sticky="w",
                                                 padx=(0, 6), pady=3)
        elif spec.type in ("int", "float") and (spec.min is not None or spec.max is not None):
            rng = f"{spec.min if spec.min is not None else ''}~" \
                  f"{spec.max if spec.max is not None else ''}"
            ttk.Label(parent, text=rng, foreground="#aaaaaa",
                      font=(FONT_UI[0], 8)).grid(row=row, column=2, sticky="w", padx=(0, 6))
        return row + 1

    def _make_widget(self, parent: tk.Misc, spec: ParamSpec) -> tuple[tk.Variable, tk.Widget]:
        default = spec.effective_default()

        if spec.type == "bool":
            var = tk.BooleanVar(value=bool(default))
            return var, ttk.Checkbutton(parent, variable=var,
                                        command=self._notify)

        if spec.type == "enum":
            values = [str(item.get("value", "")) for item in spec.enum]
            labels = {str(item.get("value", "")): str(item.get("label") or item.get("value"))
                      for item in spec.enum}
            display = [labels.get(v, v) for v in values]
            var = tk.StringVar(value=labels.get(str(default), str(default)))
            combo = ttk.Combobox(parent, textvariable=var, values=display, state="readonly")
            combo._value_map = {labels.get(v, v): v for v in values}  # type: ignore[attr-defined]
            combo.bind("<<ComboboxSelected>>", lambda _e: self._notify())
            return var, combo

        if spec.type == "int":
            var = tk.StringVar(value="" if default is None else str(int(default)))
            spin = ttk.Spinbox(parent, textvariable=var, from_=spec.min or 0,
                               to=spec.max or 100000, increment=spec.step or 1, width=14)
            spin.bind("<KeyRelease>", lambda _e: self._notify())
            return var, spin

        if spec.type == "float":
            var = tk.StringVar(value="" if default is None else str(float(default)))
            spin = ttk.Spinbox(parent, textvariable=var, from_=spec.min or 0.0,
                               to=spec.max or 100000.0, increment=spec.step or 0.1, width=14)
            spin.bind("<KeyRelease>", lambda _e: self._notify())
            return var, spin

        if spec.type == "color":
            var = tk.StringVar(value=str(default or "#FFFFFF"))

            def pick() -> None:
                current = var.get() or "#FFFFFF"
                chosen = colorchooser.askcolor(color=current, parent=self.winfo_toplevel())
                if chosen and chosen[1]:
                    var.set(chosen[1])
                    self._notify()

            holder = ttk.Frame(parent)
            entry = ttk.Entry(holder, textvariable=var, width=12)
            entry.pack(side="left", fill="x", expand=True)
            btn = ttk.Button(holder, text="…", width=3, command=pick)
            btn.pack(side="left", padx=(4, 0))
            entry.bind("<KeyRelease>", lambda _e: self._notify())
            return var, holder

        if spec.type == "path":
            var = tk.StringVar(value=str(default or ""))

            def browse() -> None:
                chosen = filedialog.askopenfilename(parent=self.winfo_toplevel())
                if chosen:
                    var.set(chosen)
                    self._notify()

            holder = ttk.Frame(parent)
            entry = ttk.Entry(holder, textvariable=var)
            entry.pack(side="left", fill="x", expand=True)
            ttk.Button(holder, text="…", width=3, command=browse).pack(side="left", padx=(4, 0))
            entry.bind("<KeyRelease>", lambda _e: self._notify())
            return var, holder

        var = tk.StringVar(value="" if default is None else str(default))
        entry = ttk.Entry(parent, textvariable=var)
        entry.bind("<KeyRelease>", lambda _e: self._notify())
        return var, entry

    def _notify(self) -> None:
        if self._on_change:
            self._on_change()

    # -- 取值 --------------------------------------------------------------- #

    def values(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for pid, var in self._vars.items():
            spec = self._specs.get(pid)
            raw = var.get()
            widget = None
            for w in self._widgets:
                if isinstance(w, ttk.Combobox) and str(w.cget("textvariable")) == str(var):
                    widget = w
                    break
            if spec and spec.type == "enum" and widget is not None:
                mapping = getattr(widget, "_value_map", {})
                out[pid] = mapping.get(str(raw), raw)
                continue
            if spec and spec.type == "bool":
                out[pid] = bool(raw)
            elif spec and spec.type == "int":
                text = str(raw).strip()
                if text == "":
                    continue
                try:
                    out[pid] = int(float(text))
                except ValueError:
                    continue
            elif spec and spec.type == "float":
                text = str(raw).strip()
                if text == "":
                    continue
                try:
                    out[pid] = float(text)
                except ValueError:
                    continue
            else:
                text = str(raw).strip()
                if text != "":
                    out[pid] = text
        return out

    def reset(self) -> None:
        for pid, spec in self._specs.items():
            var = self._vars.get(pid)
            if var is None:
                continue
            default = spec.effective_default()
            if spec.type == "bool":
                var.set(bool(default))
            elif spec.type == "enum":
                widget = next((w for w in self._widgets
                               if isinstance(w, ttk.Combobox)
                               and str(w.cget("textvariable")) == str(var)), None)
                labels = {str(i.get("value", "")): str(i.get("label") or i.get("value"))
                          for i in (spec.enum or [])}
                var.set(labels.get(str(default), str(default)))
            else:
                var.set("" if default is None else str(default))


# --------------------------------------------------------------------------- #
# 主窗口
# --------------------------------------------------------------------------- #


class KernelHubApp(tk.Tk):
    def __init__(self, auto_scan: bool = True) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self._apply_geometry()
        self.minsize(900, 600)

        self.hub = Hub()
        self.files: list[str] = []
        self.cancel_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.events: "queue.Queue[tuple[str, Any]]" = queue.Queue()
        self.current_entry = None
        self.demo = bool(os.environ.get("KERNELHUB_GUI_DEMO"))
        self.last_out_dir = paths.load_config().get("last_output_dir") or paths.OUTPUT_DIR
        paths.ensure_dir(self.last_out_dir)

        self._setup_style()
        self._build_toolbar()
        self._build_body()
        self._build_statusbar()

        if auto_scan:
            self.after(120, self.refresh_kernels)
        self.after(80, self._pump_events)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # -- 外观 --------------------------------------------------------------- #

    def _apply_geometry(self) -> None:
        """按实际屏幕尺寸挑一个既不超出屏幕、又足够宽松的初始窗口。

        注意：``launch()`` 已经把进程设为 DPI 感知，所以这里拿到的
        ``winfo_screenwidth()`` 是真实物理像素（例如 150% 缩放的 2560x1600），
        窗口不会被系统拉伸放大，字形保持清晰。
        """
        self.update_idletasks()
        try:
            sw = self.winfo_screenwidth()
            sh = self.winfo_screenheight()
        except tk.TclError:
            sw, sh = 1280, 800

        if os.environ.get("KERNELHUB_GUI_MAXIMIZE"):
            try:
                self.state("zoomed")
                return
            except tk.TclError:
                pass

        width = max(980, min(1560, int(sw * 0.80)))
        height = max(640, min(1020, int(sh * 0.84)))
        x = max(0, (sw - width) // 2 - int(sw * 0.02))
        y = max(0, (sh - height) // 3)
        self.geometry(f"{width}x{height}+{x}+{y}")

    def _setup_style(self) -> None:
        style = ttk.Style(self)
        # Windows 上优先用原生主题：复选框、下拉框的观感明显好于 clam
        for candidate in ("vista", "winnative", "clam"):
            try:
                style.theme_use(candidate)
                break
            except tk.TclError:
                continue
        style.configure(".", font=FONT_UI)
        style.configure("Treeview", rowheight=24, font=FONT_UI)
        style.configure("Treeview.Heading", font=(FONT_UI[0], 9, "bold"))
        style.configure("TLabelframe.Label", font=(FONT_UI[0], 9, "bold"))
        style.configure("Accent.TButton", font=(FONT_UI[0], 9, "bold"))
        style.configure("Hint.TLabel", foreground="#777777", font=(FONT_UI[0], 8))
        # clam 的选中指示器是个很大的叉，收窄一点
        try:
            style.configure("TCheckbutton", indicatorcolor="#ffffff")
            style.map("TCheckbutton",
                      indicatorcolor=[("selected", "#2f6fdd"), ("!selected", "#ffffff")])
        except tk.TclError:
            pass

    def _build_toolbar(self) -> None:
        bar = ttk.Frame(self, padding=(8, 6))
        bar.pack(fill="x")

        ttk.Button(bar, text="🔄 刷新内核", command=self.refresh_kernels).pack(side="left")
        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Button(bar, text="＋ 添加文件", command=self.add_files).pack(side="left")
        ttk.Button(bar, text="📁 添加目录", command=self.add_folder).pack(side="left", padx=(6, 0))
        ttk.Button(bar, text="✕ 清空队列", command=self.clear_files).pack(side="left", padx=(6, 0))
        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Button(bar, text="输出目录…", command=self.choose_output_dir).pack(side="left")
        ttk.Button(bar, text="打开输出目录", command=self.open_output_dir).pack(side="left", padx=(6, 0))
        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Button(bar, text="协议说明", command=self.show_protocol).pack(side="left")

        self.auto_kernel_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(bar, text="自动选内核", variable=self.auto_kernel_var,
                        command=self._on_auto_kernel_toggle).pack(side="right")

    def _build_body(self) -> None:
        body = ttk.Frame(self, padding=(8, 0))
        body.pack(fill="both", expand=True)

        # 左右可拖拽分栏：左＝内核列表，右＝工作区
        paned = ttk.PanedWindow(body, orient="horizontal")
        paned.pack(fill="both", expand=True)

        left = ttk.Frame(paned)
        right = ttk.Frame(paned)
        paned.add(left, weight=0)
        paned.add(right, weight=1)

        self._build_kernel_panel(left)
        self._build_work_panel(right)
        self.paned = paned
        self.after(200, lambda: self._init_sash(paned))

    # -- 左：内核列表 ------------------------------------------------------- #

    @staticmethod
    def _init_sash(paned: ttk.PanedWindow) -> None:
        """给左右分栏一个合理的初始位置（左侧约 430px）。"""
        try:
            total = paned.winfo_width()
            if total > 700:
                paned.sashpos(0, min(430, max(340, int(total * 0.30))))
        except tk.TclError:
            pass

    def _build_kernel_panel(self, parent: tk.Misc) -> None:
        frame = ttk.LabelFrame(parent, text="转换内核（插件）", padding=6)
        frame.pack(fill="both", expand=True)
        frame.rowconfigure(1, weight=1)
        frame.columnconfigure(0, weight=1)

        self.kernel_summary = ttk.Label(frame, text="正在扫描…", foreground="#666666")
        self.kernel_summary.grid(row=0, column=0, sticky="w", pady=(0, 4))

        cols = ("status", "id", "caps")
        tree = ttk.Treeview(frame, columns=cols, show="tree headings", height=14,
                            selectmode="browse")
        tree.heading("#0", text="名称")
        tree.heading("status", text="状态")
        tree.heading("id", text="id")
        tree.heading("caps", text="能力")
        tree.column("#0", width=186, minwidth=140, stretch=True)
        tree.column("status", width=58, minwidth=52, anchor="center", stretch=False)
        tree.column("id", width=126, minwidth=100, stretch=False)
        tree.column("caps", width=46, minwidth=40, anchor="center", stretch=False)
        tree.grid(row=1, column=0, sticky="nsew")

        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        sb.grid(row=1, column=1, sticky="ns")
        tree.configure(yscrollcommand=sb.set)
        self.kernel_tree = tree

        for status, fg in STATUS_FG.items():
            tree.tag_configure(status, foreground=fg)
        tree.bind("<<TreeviewSelect>>", lambda _e: self._on_kernel_select())
        tree.bind("<Double-1>", lambda _e: self.show_kernel_detail())

        btns = ttk.Frame(frame)
        btns.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Button(btns, text="详情", width=7,
                   command=self.show_kernel_detail).pack(side="left")
        ttk.Button(btns, text="启停", width=7,
                   command=self.toggle_kernel).pack(side="left", padx=(5, 0))
        ttk.Button(btns, text="安装", width=7,
                   command=self.show_install_hint).pack(side="left", padx=(5, 0))
        ttk.Button(btns, text="刷新", width=7,
                   command=self.refresh_kernels).pack(side="left", padx=(5, 0))

    # -- 中：转换工作区 ----------------------------------------------------- #

    def _build_work_panel(self, parent: tk.Misc) -> None:
        nb = ttk.Notebook(parent)
        nb.pack(fill="both", expand=True)
        self.notebook = nb

        self.tab_convert = ttk.Frame(nb, padding=8)
        self.tab_log = ttk.Frame(nb, padding=8)
        nb.add(self.tab_convert, text="  转换  ")
        nb.add(self.tab_log, text="  日志  ")

        self._build_convert_tab(self.tab_convert)
        self._build_log_tab(self.tab_log)

    def _build_convert_tab(self, parent: tk.Misc) -> None:
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(1, weight=1)

        # --- 文件队列 ---
        files_box = ttk.LabelFrame(parent, text="待转换文件", padding=6)
        files_box.grid(row=0, column=0, sticky="nsew")
        files_box.rowconfigure(0, weight=1)
        files_box.columnconfigure(0, weight=1)

        cols = ("fmt", "size")
        tree = ttk.Treeview(files_box, columns=cols, show="tree headings", height=6,
                            selectmode="extended")
        tree.heading("#0", text="文件")
        tree.heading("fmt", text="格式")
        tree.heading("size", text="大小")
        tree.column("#0", width=420, stretch=True)
        tree.column("fmt", width=64, anchor="center", stretch=False)
        tree.column("size", width=90, anchor="e", stretch=False)
        tree.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(files_box, orient="vertical", command=tree.yview)
        sb.grid(row=0, column=1, sticky="ns")
        tree.configure(yscrollcommand=sb.set)
        tree.bind("<Delete>", lambda _e: self.remove_selected_files())
        self.file_tree = tree

        # --- 转换设置 ---
        opts = ttk.LabelFrame(parent, text="转换设置", padding=8)
        opts.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        for col in (1, 3):
            opts.columnconfigure(col, weight=1)

        ttk.Label(opts, text="操作").grid(row=0, column=0, sticky="w", padx=(0, 6))
        self.op_var = tk.StringVar(value="convert")
        self.op_combo = ttk.Combobox(opts, textvariable=self.op_var, state="readonly",
                                     width=18, values=["convert"])
        self.op_combo.grid(row=0, column=1, sticky="ew", padx=(0, 14))
        self.op_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_op_change())

        ttk.Label(opts, text="目标格式").grid(row=0, column=2, sticky="w", padx=(0, 6))
        self.fmt_var = tk.StringVar(value="")
        self.fmt_combo = ttk.Combobox(opts, textvariable=self.fmt_var, state="readonly",
                                      width=18, values=[])
        self.fmt_combo.grid(row=0, column=3, sticky="ew")
        self.fmt_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_target_change())

        ttk.Label(opts, text="指定内核").grid(row=1, column=0, sticky="w", padx=(0, 6),
                                              pady=(6, 0))
        self.kernel_var = tk.StringVar(value="（自动选择）")
        self.kernel_combo = ttk.Combobox(opts, textvariable=self.kernel_var, state="readonly",
                                         width=18, values=["（自动选择）"])
        self.kernel_combo.grid(row=1, column=1, sticky="ew", padx=(0, 14), pady=(6, 0))
        self.kernel_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_target_change())

        ttk.Label(opts, text="输出").grid(row=1, column=2, sticky="w", padx=(0, 6), pady=(6, 0))
        out_holder = ttk.Frame(opts)
        out_holder.grid(row=1, column=3, sticky="ew", pady=(6, 0))
        out_holder.columnconfigure(0, weight=1)
        self.out_var = tk.StringVar(value=self.last_out_dir)
        ttk.Entry(out_holder, textvariable=self.out_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(out_holder, text="…", width=3,
                   command=self.choose_output_dir).grid(row=0, column=1, padx=(4, 0))

        self.same_dir_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(opts, text="输出到源文件所在目录", variable=self.same_dir_var,
                        command=self._on_target_change).grid(row=2, column=0,
                                                             columnspan=2, sticky="w",
                                                             pady=(6, 0))
        self.dry_run_note = ttk.Label(opts, text="", foreground="#1a7f37")
        self.dry_run_note.grid(row=2, column=2, columnspan=2, sticky="e", pady=(6, 0))

        # --- 参数面板 ---
        params_box = ttk.LabelFrame(parent, text="参数（协议驱动自动生成）", padding=6)
        params_box.grid(row=2, column=0, sticky="nsew", pady=(8, 0))
        params_box.rowconfigure(0, weight=1)
        params_box.columnconfigure(0, weight=1)
        parent.rowconfigure(2, weight=1)
        self.params_panel = ParamPanel(params_box, on_change=self._on_params_change)
        self.params_panel.grid(row=0, column=0, sticky="nsew")

        # --- 执行 ---
        run = ttk.Frame(parent)
        run.grid(row=3, column=0, sticky="ew", pady=(8, 0))
        run.columnconfigure(0, weight=1)

        self.progress = ttk.Progressbar(run, mode="determinate", maximum=100)
        self.progress.grid(row=0, column=0, sticky="ew")
        self.run_btn = ttk.Button(run, text="▶ 开始转换", style="Accent.TButton",
                                  command=self.start_convert)
        self.run_btn.grid(row=0, column=1, padx=(8, 0))
        self.cancel_btn = ttk.Button(run, text="■ 取消", command=self.cancel_convert,
                                     state="disabled")
        self.cancel_btn.grid(row=0, column=2, padx=(6, 0))

        self.summary_var = tk.StringVar(value="就绪")
        ttk.Label(run, textvariable=self.summary_var, foreground="#666666").grid(
            row=1, column=0, columnspan=3, sticky="w", pady=(4, 0))

    def _build_log_tab(self, parent: tk.Misc) -> None:
        parent.rowconfigure(0, weight=1)
        parent.columnconfigure(0, weight=1)
        self.log_text = tk.Text(parent, wrap="none", font=FONT_MONO, height=20,
                                background="#1e1e1e", foreground="#d4d4d4",
                                insertbackground="#d4d4d4")
        self.log_text.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(parent, orient="vertical", command=self.log_text.yview)
        sb.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=sb.set)

        btns = ttk.Frame(parent)
        btns.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Button(btns, text="清空日志", command=lambda: self.log_text.delete("1.0", "end")
                   ).pack(side="left")
        ttk.Button(btns, text="复制全部", command=self._copy_log).pack(side="left", padx=(6, 0))

    def _build_statusbar(self) -> None:
        bar = ttk.Frame(self, padding=(8, 4))
        bar.pack(fill="x", side="bottom")
        self.status_var = tk.StringVar(value="正在初始化…")
        ttk.Label(bar, textvariable=self.status_var, foreground="#444444").pack(side="left")
        ttk.Label(bar, text=f"CKP {CKP_VERSION}", foreground="#999999").pack(side="right")

    # -- 日志 --------------------------------------------------------------- #

    def log(self, message: str, level: str = "info") -> None:
        stamp = time.strftime("%H:%M:%S")
        prefix = {"info": "  ", "warn": "! ", "error": "✕ ", "ok": "✓ ", "debug": "· "}.get(
            level, "  ")
        line = f"[{stamp}] {prefix}{message}\n"
        self.log_text.insert("end", line)
        self.log_text.see("end")
        if level == "error":
            self.notebook.select(self.tab_log)

    def _copy_log(self) -> None:
        self.clipboard_clear()
        self.clipboard_append(self.log_text.get("1.0", "end"))
        self.summary_var.set("日志已复制到剪贴板")

    # -- 内核刷新 ----------------------------------------------------------- #

    def refresh_kernels(self) -> None:
        self.status_var.set("正在扫描内核…")
        self.update_idletasks()
        try:
            self.hub.refresh()
        except Exception as exc:  # noqa: BLE001
            self.log(f"扫描内核失败: {exc}", "error")
            self.log(traceback.format_exc(), "debug")
            return

        registry = self.hub.registry
        tree = self.kernel_tree
        tree.delete(*tree.get_children())
        for entry in registry.all_entries():
            status = entry.status
            caps = sum(len(c.from_) * len(c.to) for c in entry.manifest.capabilities)
            tree.insert("", "end", iid=entry.id,
                        text=f" {STATUS_GLYPH.get(status, '·')} {entry.name}",
                        values=(STATUS_LABELS_ZH.get(status, status), entry.id, caps),
                        tags=(status,))

        summary = registry.summary()
        self.kernel_summary.configure(
            text=f"可用 {summary['ready']} / 共 {summary['total']} 个内核")

        ops = registry.ops() or ["convert"]
        self.op_combo.configure(values=ops)
        if self.op_var.get() not in ops:
            self.op_var.set(ops[0])

        kernels = ["（自动选择）"] + [e.id for e in registry.ready_entries()]
        self.kernel_combo.configure(values=kernels)
        if self.kernel_var.get() not in kernels:
            self.kernel_var.set("（自动选择）")

        for err in registry.errors:
            self.log(err, "warn")

        ready = [e.id for e in registry.ready_entries()]
        self.log(f"内核扫描完成：{len(ready)} 个可用 / {len(registry.entries)} 个发现", "ok")
        for entry in registry.all_entries():
            if entry.status != "ready":
                self.log(f"  {entry.id}: {STATUS_LABELS_ZH.get(entry.status)} — "
                         f"{entry.detail[:100]}", "warn")
        self.status_var.set(f"内核：{len(ready)} 可用 / {len(registry.entries)} 总数")
        self._on_target_change()
        if self.demo and not self.files:
            self._load_demo()

    def _load_demo(self) -> None:
        """演示/试用模式：把测试素材填进队列，方便一眼看懂工具怎么用。"""
        fixture_dir = os.path.join(paths.OUTPUT_DIR, "fixtures")
        if not os.path.isdir(fixture_dir):
            self.log("演示模式：未找到测试素材，可先运行 tools/make_fixtures.py", "warn")
            return
        picks = [n for n in ("photo-like.jpg", "alpha-gradient.png", "plain.bmp",
                             "plain.webp", "tiny.png")
                 if os.path.isfile(os.path.join(fixture_dir, n))]
        if picks:
            self._append_files([os.path.join(fixture_dir, n) for n in picks])
        demo_out = os.path.join(paths.OUTPUT_DIR, "gui-demo")
        paths.ensure_dir(demo_out)
        self.out_var.set(demo_out)
        values = list(self.fmt_combo.cget("values") or [])
        for preferred in ("webp", "png", "jpg"):
            if preferred in values:
                self.fmt_var.set(preferred)
                break
        self._on_target_change()
        self.log("演示模式已开启（KERNELHUB_GUI_DEMO=1），可直接点「开始转换」", "ok")
        if os.environ.get("KERNELHUB_GUI_DEMO", "").lower() in ("run", "auto", "convert"):
            self.log("演示模式：2 秒后自动执行一次转换…", "info")
            self.after(2000, self.start_convert)

    # -- 文件队列 ----------------------------------------------------------- #

    def add_files(self) -> None:
        chosen = filedialog.askopenfilenames(title="选择要转换的文件",
                                             initialdir=os.path.dirname(
                                                 self.files[0]) if self.files else None)
        self._append_files(list(chosen))

    def add_folder(self) -> None:
        folder = filedialog.askdirectory(title="选择目录（递归添加其中所有文件）")
        if not folder:
            return
        found: list[str] = []
        for root, _dirs, names in os.walk(folder):
            for name in names:
                found.append(os.path.join(root, name))
        if len(found) > 500 and not messagebox.askyesno(
                "确认", f"该目录下有 {len(found)} 个文件，全部加入队列？"):
            return
        self._append_files(found[:2000])

    def _append_files(self, items: list[str]) -> None:
        added = 0
        for path in items:
            path = os.path.abspath(path)
            if path in self.files or not os.path.isfile(path):
                continue
            self.files.append(path)
            fmt = format_of_path(path) or "?"
            try:
                size = human_size(os.path.getsize(path))
            except OSError:
                size = "?"
            self.file_tree.insert("", "end", iid=path,
                                  text=f" {os.path.basename(path)}",
                                  values=(fmt, size))
            added += 1
        if added:
            self.log(f"加入 {added} 个文件，队列共 {len(self.files)} 个")
        self._on_target_change()

    def clear_files(self) -> None:
        self.files.clear()
        self.file_tree.delete(*self.file_tree.get_children())
        self.summary_var.set("队列已清空")
        self._on_target_change()

    def remove_selected_files(self) -> None:
        for iid in self.file_tree.selection():
            if iid in self.files:
                self.files.remove(iid)
            self.file_tree.delete(iid)
        self._on_target_change()

    # -- 选项联动 ----------------------------------------------------------- #

    def _selected_source_format(self) -> str:
        if not self.files:
            return ""
        fmts: dict[str, int] = {}
        for path in self.files:
            fmt = format_of_path(path)
            fmts[fmt] = fmts.get(fmt, 0) + 1
        return max(fmts.items(), key=lambda kv: kv[1])[0]

    def _on_op_change(self) -> None:
        self._on_target_change()

    def _on_target_change(self) -> None:
        registry = self.hub.registry
        op = self.op_var.get() or "convert"
        src_fmt = self._selected_source_format()

        targets: list[str] = []
        if src_fmt:
            targets = registry.targets_for(op, src_fmt)
        if not targets:
            targets = registry.output_formats(op)

        # 若用户在「指定内核」里选了具体内核，按其能力收窄
        chosen_kernel = self.kernel_var.get()
        if chosen_kernel and chosen_kernel != "（自动选择）":
            entry = registry.get(chosen_kernel)
            if entry:
                limited: list[str] = []
                for cap in entry.manifest.capabilities:
                    if cap.op != op:
                        continue
                    if src_fmt and not cap.accepts_input(src_fmt):
                        continue
                    limited.extend(f for f in cap.to if f != "*")
                if limited:
                    targets = sorted(set(limited))

        self.fmt_combo.configure(values=targets)
        if self.fmt_var.get() not in targets:
            self.fmt_var.set(targets[0] if targets else "")

        self._rebuild_params(src_fmt)
        self._update_preview(src_fmt)

    def _on_auto_kernel_toggle(self) -> None:
        if self.auto_kernel_var.get():
            self.kernel_var.set("（自动选择）")
        self._on_target_change()

    def _on_params_change(self) -> None:
        pass

    def _rebuild_params(self, src_fmt: str) -> None:
        registry = self.hub.registry
        op = self.op_var.get() or "convert"
        dst_fmt = self.fmt_var.get()
        chosen = self.kernel_var.get()

        entries = []
        if chosen and chosen != "（自动选择）":
            entry = registry.get(chosen)
            if entry:
                entries = [entry]
        if not entries:
            entries = [e for e, _cap in registry.candidates(op, src_fmt, dst_fmt)]
        if not entries:
            entries = registry.ready_entries()

        specs: list[ParamSpec] = []
        if entries:
            primary = entries[0]
            caps = primary.manifest.find_capabilities(op, src_fmt, dst_fmt)
            cap_params = caps[0].params if caps else []
            specs = merge_params(primary.manifest.params, cap_params)
            self.current_entry = primary
        else:
            self.current_entry = None

        self.params_panel.rebuild(specs, op, src_fmt, dst_fmt)

    def _update_preview(self, src_fmt: str) -> None:
        if not self.files:
            self.dry_run_note.configure(text="")
            return
        op = self.op_var.get() or "convert"
        dst_fmt = self.fmt_var.get()
        if not dst_fmt:
            self.dry_run_note.configure(text="")
            return
        try:
            entry, _cap = self.hub.registry.resolve(op, src_fmt, dst_fmt)
            self.dry_run_note.configure(
                text=f"将使用：{entry.name}", foreground="#1a7f37")
            self.current_entry = entry
        except Exception as exc:  # noqa: BLE001
            self.dry_run_note.configure(text=f"没有可用内核：{str(exc)[:70]}",
                                        foreground="#c0392b")

    # -- 输出目录 ----------------------------------------------------------- #

    def choose_output_dir(self) -> None:
        folder = filedialog.askdirectory(title="选择输出目录",
                                         initialdir=self.out_var.get() or None)
        if folder:
            self.out_var.set(folder)
            self.last_out_dir = folder
            self.same_dir_var.set(False)

    def open_output_dir(self) -> None:
        target = self.out_var.get() or self.last_out_dir
        if not os.path.isdir(target):
            messagebox.showwarning("目录不存在", target)
            return
        try:
            if os.name == "nt":
                os.startfile(target)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                import subprocess

                subprocess.Popen(["open", target])
            else:
                import subprocess

                subprocess.Popen(["xdg-open", target])
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("打开失败", str(exc))

    # -- 转换 --------------------------------------------------------------- #

    def start_convert(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        if not self.files:
            messagebox.showinfo("没有文件", "请先添加要转换的文件。")
            return

        op = self.op_var.get() or "convert"
        dst_fmt = self.fmt_var.get()
        if not dst_fmt:
            messagebox.showwarning("缺少目标格式", "请选择目标格式。")
            return

        out_dir = "" if self.same_dir_var.get() else (self.out_var.get() or "").strip()
        if out_dir:
            paths.ensure_dir(out_dir)
            self.last_out_dir = out_dir
            cfg = paths.load_config()
            cfg["last_output_dir"] = out_dir
            paths.save_config(cfg)

        params = self.params_panel.values()
        kernel_id = "" if self.kernel_var.get() == "（自动选择）" else self.kernel_var.get()

        self.cancel_event.clear()
        self.progress.configure(value=0, maximum=len(self.files))
        self.run_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.summary_var.set(f"开始转换 {len(self.files)} 个文件…")
        self.log("─" * 60)
        self.log(f"任务：{op} → {dst_fmt}，{len(self.files)} 个文件，"
                 f"内核={kernel_id or '自动'}，参数={params or '{}'}")

        files = list(self.files)
        self.worker = threading.Thread(
            target=self._worker_convert,
            args=(files, op, dst_fmt, out_dir, params, kernel_id),
            daemon=True, name="kernelhub-worker")
        self.worker.start()

    def _worker_convert(self, files: list[str], op: str, dst_fmt: str,
                        out_dir: str, params: dict[str, Any], kernel_id: str) -> None:
        ok = 0
        fail = 0
        started = time.time()
        taken: list[str] = []
        total = len(files)

        for index, src in enumerate(files, 1):
            if self.cancel_event.is_set():
                self.events.put(("log", ("已取消，剩余文件不再处理", "warn")))
                break

            target_dir = os.path.dirname(src) if not out_dir else out_dir
            out_path = default_output_path(src, dst_fmt, target_dir, taken)
            taken.append(out_path)

            req = ConvertRequest(sources=[src], target_format=dst_fmt, op=op,
                                 out_path=out_path, params=params, kernel_id=kernel_id)
            self.events.put(("log", (f"[{index}/{total}] {os.path.basename(src)} → "
                                     f"{os.path.basename(out_path)}", "info")))

            def on_log(message: str, level: str) -> None:
                if level in ("warn", "error") or message.startswith(("执行:", "耗时", "源:")):
                    self.events.put(("log", (f"    {message}", level if level != "info" else "debug")))

            try:
                outcome = self.hub.convert(req, on_log=on_log,
                                           cancel=self.cancel_event)
            except Exception as exc:  # noqa: BLE001
                self.events.put(("log", (f"    异常 {type(exc).__name__}: {exc}", "error")))
                fail += 1
                self.events.put(("progress", (index, f"{index}/{total}")))
                continue

            if outcome.ok:
                ok += 1
                prim = outcome.primary_output() or {}
                size = prim.get("bytes")
                extra = f"（{human_size(size)}）" if size else ""
                kernel = outcome.kernel_id
                if len(outcome.outputs) > 1:
                    extra = f"（{len(outcome.outputs)} 个产物）"
                self.events.put(("log", (f"    ✓ {kernel} 完成 {extra} "
                                         f"{outcome.duration_ms}ms", "ok")))
            else:
                fail += 1
                err = outcome.error or {}
                self.events.put(("log", (f"    ✕ [{err.get('code')}] "
                                         f"{err.get('message')}", "error")))
                detail = str(err.get("detail") or "").strip()
                if detail:
                    for line in detail.splitlines()[-6:]:
                        self.events.put(("log", (f"        {line}", "debug")))

            self.events.put(("progress", (index, f"{index}/{total}")))

        elapsed = time.time() - started
        self.events.put(("done", {"ok": ok, "fail": fail, "seconds": elapsed,
                                  "total": total, "out_dir": out_dir}))

    def cancel_convert(self) -> None:
        self.cancel_event.set()
        self.cancel_btn.configure(state="disabled")
        self.summary_var.set("正在取消…")

    # -- 事件泵 ------------------------------------------------------------- #

    def _pump_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "log":
                    message, level = payload
                    self.log(message, level)
                elif kind == "progress":
                    value, label = payload
                    self.progress.configure(value=value)
                    self.summary_var.set(f"进行中 {label}")
                elif kind == "done":
                    self._on_convert_done(payload)
        except queue.Empty:
            pass
        self.after(80, self._pump_events)

    def _on_convert_done(self, info: dict[str, Any]) -> None:
        self.run_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")
        cancelled = self.cancel_event.is_set()
        state = "已取消" if cancelled else "完成"
        self.summary_var.set(
            f"{state}：成功 {info['ok']}，失败 {info['fail']}，"
            f"共 {info['total']}，用时 {info['seconds']:.1f}s")
        level = "warn" if info["fail"] else "ok"
        self.log(f"{state}：成功 {info['ok']} / 失败 {info['fail']} / 共 {info['total']}，"
                 f"用时 {info['seconds']:.1f}s", level)
        if info["ok"] and not info["fail"] and info.get("out_dir"):
            self.status_var.set(f"产物已写入 {info['out_dir']}")

    # -- 内核操作 ----------------------------------------------------------- #

    def _on_kernel_select(self) -> None:
        pass

    def _current_kernel_id(self) -> str:
        selection = self.kernel_tree.selection()
        return selection[0] if selection else ""

    def show_kernel_detail(self) -> None:
        kid = self._current_kernel_id()
        if not kid:
            messagebox.showinfo("提示", "请先在左侧选择一个内核。")
            return
        entry = self.hub.registry.get(kid)
        if entry is None:
            return

        win = tk.Toplevel(self)
        win.title(f"内核详情 — {entry.name}")
        win.geometry("760x620")
        win.transient(self)

        text = tk.Text(win, wrap="word", font=FONT_MONO, padx=10, pady=10)
        text.pack(fill="both", expand=True)
        sb = ttk.Scrollbar(win, orient="vertical", command=text.yview)
        sb.pack(side="right", fill="y")
        text.configure(yscrollcommand=sb.set)

        m = entry.manifest
        lines = [
            f"名称        : {m.name}",
            f"id          : {m.id}",
            f"版本        : {m.version}      协议: CKP {m.ckp}",
            f"分类        : {m.kind}          优先级: {m.priority}",
            f"状态        : {STATUS_LABELS_ZH.get(entry.status, entry.status)}"
            f"   {'（' + entry.detail + '）' if entry.detail else ''}",
            f"引擎        : {entry.engine_note or '—'}",
            f"许可        : {m.license or '—'}",
            f"主页        : {m.homepage or '—'}",
            f"插件目录    : {entry.directory}",
            f"适配器入口  : {entry.entry_path}",
        ]
        if entry.install_hint():
            lines.append(f"安装方式    : {entry.install_hint()}")
        lines += ["", "── 说明 " + "─" * 50, m.description or "（无）"]

        lines += ["", "── 能力矩阵 " + "─" * 46]
        for cap in m.capabilities:
            lines.append(f"[{cap.op}]  {cap.id}")
            lines.append(f"   输入 : {', '.join(cap.from_)}")
            lines.append(f"   输出 : {', '.join(cap.to)}")
            flags = []
            if cap.multi_in:
                flags.append("多输入")
            if cap.multi_out:
                flags.append("多输出")
            if flags:
                lines.append(f"   特性 : {'、'.join(flags)}")
            lines.append("")

        all_params = m.params
        lines += ["── 参数声明 " + "─" * 46]
        if not all_params:
            lines.append("（无）")
        for spec in all_params:
            cond = ""
            if spec.when:
                cond = "  条件: " + ", ".join(f"{k}∈{v}" for k, v in spec.when.items())
            if spec.applies_to:
                cond += f"  仅用于: {spec.applies_to}"
            lines.append(f"{spec.id:<22} {spec.type:<8} 默认={spec.effective_default()!r}"
                         f"{'  [高级]' if spec.advanced else ''}{cond}")
            if spec.description:
                lines.append(f"    {spec.description}")

        lines += ["", "── 原始清单（kernel.json） " + "─" * 28]
        import json as _json

        lines.append(_json.dumps(m.to_dict(), ensure_ascii=False, indent=2))

        text.insert("1.0", "\n".join(lines))
        text.configure(state="disabled")

    def show_install_hint(self) -> None:
        kid = self._current_kernel_id()
        if not kid:
            messagebox.showinfo("提示", "请先在左侧选择一个内核。")
            return
        entry = self.hub.registry.get(kid)
        if entry is None:
            return
        hint = entry.install_hint()
        if not hint:
            messagebox.showinfo("安装方式",
                                f"{entry.name} 没有提供安装钩子。\n\n"
                                "它可能已经可用，或者需要手动安装其依赖引擎。")
            return
        message = (f"内核：{entry.name}\n当前状态："
                   f"{STATUS_LABELS_ZH.get(entry.status, entry.status)}\n\n"
                   f"建议安装命令：\n\n{hint}\n\n"
                   "点击「是」将执行这条命令（需要联网）。")
        if messagebox.askyesno("安装内核引擎", message, icon="question"):
            self._run_install(entry)

    def _run_install(self, entry: Any) -> None:
        hook = (entry.manifest.hooks or {}).get("install") or {}
        if hook.get("type") != "command" or not hook.get("command"):
            messagebox.showinfo("无法安装", "该内核没有可执行的安装命令。")
            return
        command = [str(hook["command"])] + [str(a) for a in (hook.get("args") or [])]

        def worker() -> None:
            import subprocess

            self.events.put(("log", (f"执行安装：{' '.join(command)}", "info")))
            try:
                proc = subprocess.run(
                    command, cwd=paths.PROJECT_ROOT, capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=1800,
                    creationflags=0x08000000 if os.name == "nt" else 0)
                for line in (proc.stdout or "").splitlines()[-20:]:
                    self.events.put(("log", (f"    {line}", "debug")))
                for line in (proc.stderr or "").splitlines()[-10:]:
                    self.events.put(("log", (f"    {line}", "warn")))
                level = "ok" if proc.returncode == 0 else "error"
                self.events.put(("log", (f"安装退出码 {proc.returncode}", level)))
            except Exception as exc:  # noqa: BLE001
                self.events.put(("log", (f"安装失败: {exc}", "error")))
            self.events.put(("refresh", None))

        threading.Thread(target=worker, daemon=True, name="kernelhub-install").start()

    def toggle_kernel(self) -> None:
        kid = self._current_kernel_id()
        if not kid:
            messagebox.showinfo("提示", "请先在左侧选择一个内核。")
            return
        entry = self.hub.registry.get(kid)
        if entry is None:
            return
        enable = entry.status == "disabled"
        if self.hub.registry.set_enabled(kid, enable):
            self.log(f"{'启用' if enable else '停用'}内核 {kid}", "ok")
            self.refresh_kernels()
        else:
            messagebox.showerror("保存失败", "无法写入用户配置。")

    # -- 协议说明 ----------------------------------------------------------- #

    def show_protocol(self) -> None:
        win = tk.Toplevel(self)
        win.title("CKP 协议说明")
        win.geometry("820x640")
        win.transient(self)

        header = ttk.Frame(win, padding=10)
        header.pack(fill="x")
        ttk.Label(header, text=f"CKP (Conversion Kernel Protocol) v{CKP_VERSION}",
                  font=(FONT_UI[0], 13, "bold")).pack(anchor="w")
        ttk.Label(header, foreground="#666666",
                  text="内核只需实现「一份清单 + 一个读 stdin 的适配器」，即可被本工具自动发现与调用。"
                  ).pack(anchor="w", pady=(4, 0))

        nb = ttk.Notebook(win)
        nb.pack(fill="both", expand=True, padx=10, pady=(0, 10))

        proto_path = os.path.join(paths.PROJECT_ROOT, "PROTOCOL.md")
        text = tk.Text(nb, wrap="word", font=FONT_MONO, padx=10, pady=10)
        text.pack(fill="both", expand=True)
        if os.path.isfile(proto_path):
            with open(proto_path, "r", encoding="utf-8") as fh:
                text.insert("1.0", fh.read())
        else:
            text.insert("1.0", f"未找到协议文档：{proto_path}")
        sb = ttk.Scrollbar(win, orient="vertical", command=text.yview)
        text.configure(yscrollcommand=sb.set)
        nb.add(text, text="  PROTOCOL.md  ")

        # 内核清单原始数据
        raw = tk.Text(nb, wrap="none", font=FONT_MONO, padx=10, pady=10)
        import json as _json

        raw.insert("1.0", _json.dumps(self.hub.registry.public_list(),
                                      ensure_ascii=False, indent=2))
        raw.configure(state="disabled")
        nb.add(raw, text="  已发现内核 JSON  ")

        # Schema 文件列表
        info = tk.Text(nb, wrap="word", font=FONT_MONO, padx=10, pady=10)
        info.insert("1.0", self._schema_text())
        info.configure(state="disabled")
        nb.add(info, text="  协议 Schema  ")

    def _schema_text(self) -> str:
        lines = [f"协议 Schema 目录：{paths.SCHEMA_DIR}", ""]
        for name in os.listdir(paths.SCHEMA_DIR) if os.path.isdir(paths.SCHEMA_DIR) else []:
            path = os.path.join(paths.SCHEMA_DIR, name)
            lines.append(f"  · {name:<38} {os.path.getsize(path):,} B")
        lines += [
            "",
            "宿主在加载内核时会用 kernel-manifest.schema.json 校验清单，",
            "不合法的内核会被标记为 invalid 并在界面中报错，但不会被静默忽略。",
            "",
            "── 如何新增一个内核 ──────────────────────────────",
            "",
            "1) 命令行工具（零代码）：",
            "     python tools/new_kernel.py cli my-tool --name \"我的工具\" --engine \"MyTool\"",
            "   然后编辑 plugins/my-tool/kernel.json 的 x-cli 段。",
            "",
            "2) Python 自定义：",
            "     python tools/new_kernel.py python my-kernel --name \"我的内核\"",
            "   然后在 plugins/my-kernel/adapter.py 里实现 handler()。",
            "",
            "3) 改完点工具栏「刷新内核」即可，无需重启。",
        ]
        return "\n".join(lines)

    # -- 关闭 --------------------------------------------------------------- #

    def _on_close(self) -> None:
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno("正在转换", "还有任务在跑，确定退出？"):
                return
            self.cancel_event.set()
        self.destroy()


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #


def launch(auto_scan: bool = True) -> int:
    """启动图形界面。返回进程退出码。"""
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    try:
        app = KernelHubApp(auto_scan=auto_scan)
    except tk.TclError as exc:
        print(f"无法启动图形界面（{exc}）。", file=sys.stderr)
        print("当前环境可能没有可用的显示设备；请改用命令行：python -m kernelhub list",
              file=sys.stderr)
        return 2
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(launch())
