'use strict';
/**
 * 受限目录检测（低完整性 / No-Write-Up）。
 *
 * 背景：本机工作区目录被标记为
 *   Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
 * 也就是「低完整性 + No-Write-Up」。这是 Windows 的强制完整性控制（MIC），
 * 属于内核策略，**不是文件 ACL，改权限没用**。它的效果是：
 *   · 低完整性进程不能在这个目录里创建/写入对象；
 *   · Electron/Chromium 的渲染进程与 GPU 进程正是以【低完整性】运行的（沙箱机制），
 *     它们启动时要在此目录内建临时文件并向上请求更高完整性 → 被 (NW) 直接拒绝；
 *   · 于是 Chromium 在初始化阶段就挂掉，退出码 0x80000003（STATUS_BREAKPOINT），
 *     主进程连一行 JS 都执行不到 —— 表现为「双击 exe 完全没反应」。
 *
 * 因此任何要跑 Electron 的目录，都必须不是 Low 完整性。
 * 这个模块负责把这件事检测出来并给出人话解释。
 *
 * Node 侧实现：直接读 DACL 里的 MANDATORY_LABEL（SDDL 以 "S:" 段出现），
 * 不依赖 PowerShell 引号与本地化字符串，跨语言环境稳定。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 用 icacls 拿到 SDDL 形式的标签（如 S:(NW) 或 S:(ML;;NW;;;LW)） */
function rawLabel(dir) {
  try {
    const out = execFileSync('icacls', [dir], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const lines = String(out).split(/\r?\n/);
    // icacls 输出里「Mandatory Label」那一行；不同语言下这一行的关键字会变，
    // 所以同时用 SDDL 形式兜底
    const byKeyword = lines.find((l) => /Mandatory Label/i.test(l)) || '';
    const bySddl = lines.find((l) => /\bS:\(/.test(l)) || '';
    return (byKeyword + ' ' + bySddl).trim();
  } catch {
    return '';
  }
}

/** 是否低完整性（含 NW 更糟，因为低完整性进程连写都不允许） */
function detect(dir) {
  if (process.platform !== 'win32') return { restricted: false, reason: '' };
  const raw = rawLabel(dir);
  if (!raw) return { restricted: false, reason: '' };

  const low = /Low Mandatory Level|;;;LW\)|\(LW\)/i.test(raw);
  const noWriteUp = /\(NW\)/i.test(raw);
  if (!low) return { restricted: false, raw };

  return {
    restricted: true,
    low,
    noWriteUp,
    raw,
    reason: noWriteUp
      ? '该目录被标记为「低完整性 + No-Write-Up」，Electron 的沙箱子进程无法在其中启动'
      : '该目录被标记为「低完整性」，Electron 的沙箱子进程可能无法启动',
  };
}

/** 给命令行用的一段解释 */
function explain(dir) {
  const info = detect(dir);
  const lines = [];
  lines.push(`目录完整性检查：${dir}`);
  lines.push(`  标签：${info.raw || '（无 Mandatory Label → 默认中完整性，正常）'}`);
  if (info.restricted) {
    lines.push('');
    lines.push('  ✗ 这个目录跑不了 Electron 应用（会静默失败，退出码 0x80000003）');
    lines.push('    原因：Windows 强制完整性控制（MIC）——不是文件权限，改 ACL 没有用。');
    lines.push('    Chromium 的渲染进程/GPU 进程以低完整性运行，在此目录内无法创建文件、也无法提升，');
    lines.push('    于是浏览器内核在初始化阶段就被系统拒绝。');
    lines.push('');
    lines.push('  处理办法：把程序复制到普通目录再运行，例如');
    lines.push('    %LOCALAPPDATA%\\Programs\\KernelHub Studio');
    lines.push('    D:\\Apps\\KernelHub Studio');
    lines.push('    桌面');
  } else {
    lines.push('  ✓ 可以在此目录运行 Electron 应用');
  }
  return lines.join('\n');
}

module.exports = { detect, explain, rawLabel };

if (require.main === module) {
  const target = process.argv[2] || __dirname;
  console.log(explain(path.resolve(target)));
  process.exit(detect(path.resolve(target)).restricted ? 1 : 0);
}
