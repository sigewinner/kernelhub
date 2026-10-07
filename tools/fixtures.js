'use strict';
/**
 * 示例素材生成 —— tools/ 下的转发壳。
 *
 * 真正的实现在 src/shared/fixtures.js（因为它必须随应用打包，
 * 而 tools/ 不会进包）。这里保留一层转发，方便命令行直接调用：
 *
 *   node tools/fixtures.js [输出目录]
 */

module.exports = require('../src/shared/fixtures.js');

if (require.main === module) {
  const path = require('path');
  const { makeFixtures } = module.exports;
  const dir = process.argv[2] || path.join(process.cwd(), 'examples');
  const files = makeFixtures(dir);
  console.log(`已生成 ${files.length} 个示例素材 → ${dir}`);
  for (const f of files) console.log('  ' + path.basename(f));
}
