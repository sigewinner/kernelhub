'use strict';
/**
 * depsReason.js —— 把依赖补装的失败原因码翻成用户能看懂、能照做的一句话（2.3.0）
 *
 * 为什么单独放一个文件：内核详情卡与插件目录两处都要用（共用一套说法），
 * 而且引擎只回一个原因码（index-missing / network / permission / no-pip / no-python），
 * 文案必须留在 i18n 这一层，才能跟着语言切换。
 *
 * 实测背景：Python 3.14 上清华镜像对不少包还没有可用版本
 * （pip 报 `No matching distribution found`），而官方源有 cp314 轮子 ——
 * 所以 index-missing 要明确告诉用户「是这个源没有你的 Python 版本」，
 * 而不是丢一句英文报错让人自己去猜。
 */

import { t } from './i18n.js';

export function depsReasonText(res) {
  const reason = res && res.reason;
  const version = (res && res.pythonVersion) || '';
  if (reason === 'index-missing') return t('该源上没有适配你 Python {0} 的包', { 0: version || '?' });
  if (reason === 'network') return t('网络不通或超时，请检查代理后重试');
  if (reason === 'permission') return t('没有写入权限（目录可能被占用或被安全软件拦截）');
  if (reason === 'no-pip') return t('这个 Python 里没有 pip，请先安装 pip');
  if (reason === 'no-python') return t('没有找到可用的 Python 解释器');
  return (res && res.error) || '';
}

/** 失败时统一的提示文案（附上试过的源，便于排查） */
export function depsFailureDetail(res) {
  const text = depsReasonText(res);
  const tried = res && Array.isArray(res.tried) && res.tried.length ? t('已尝试 {0}', { 0: res.tried.join(' / ') }) : '';
  return [text, tried].filter(Boolean).join(' · ');
}
