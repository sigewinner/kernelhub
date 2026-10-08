; ==============================================================================
; khs-installer.nsh —— 自定义 NSIS include（electron-builder 的 nsis.include）
;
; 这个文件在生成脚本的 preamble 阶段被 include，所以这里 !define 的东西
; 会先于模板生效（模板用 !ifndef 判断，我们定义了它就听我们的）。
;
; 为什么叫 khs-installer.nsh 而不是 installer.nsh：
; 模板的 installSection.nsh 会 `!include installer.nsh`（指模板自己的 include/installer.nsh），
; 同名会把它顶掉，构建直接失败。
; ==============================================================================

; 完成页不要「运行 KernelHub Studio」复选框：
; 用户要给的参数只有安装路径，装完自己从开始菜单打开就行。
!define HIDE_RUN_AFTER_FINISH

; 完成页文案：一句话说清装到哪了，不做多余引导。
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "KernelHub Studio 已安装到：$INSTDIR$\r$\n$\r$\n已安装的插件与设置保存在用户目录，不受重装影响。"
