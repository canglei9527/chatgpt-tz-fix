#!/usr/bin/env node
/*
 * tests/realm-probe.cjs —— 「页面环境」采集器（供集成测试以子进程方式运行）
 *
 * 模拟浏览器 content script 的加载方式：
 *   native 模式：不加载伪装脚本，父进程给它设置 TZ=<zone>，即「真身环境」
 *   shim   模式：先执行 inject/zones/<slug>.js，再执行 inject/tz-shim.js，即「伪装环境」
 * 然后加载 verify-fingerprint.js 采集观测值，写到输出文件。
 *
 * 用法：node tests/realm-probe.cjs <zone> <slug> <native|shim> <out.json>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const [zone, slug, mode, outFile] = process.argv.slice(2);

if (!zone || !slug || !mode || !outFile) {
  console.error('usage: node tests/realm-probe.cjs <zone> <slug> <native|shim> <out.json>');
  process.exit(2);
}

function runScript(file) {
  const code = fs.readFileSync(file, 'utf8');
  vm.runInThisContext(code, { filename: file });
}

// 与真实内容脚本一致的加载顺序：先 zone 变量文件，再伪装脚本
globalThis.__DSH_TZ_FIX_ZONE__ = mode === 'shim' ? zone : '';
if (mode === 'shim') {
  const zoneFile = path.join(ROOT, 'extension', 'inject', 'zones', slug + '.js');
  const shimFile = path.join(ROOT, 'extension', 'inject', 'tz-shim.js');
  if (!fs.existsSync(zoneFile)) throw new Error('缺少时区文件: ' + zoneFile);
  if (!fs.existsSync(shimFile)) throw new Error('缺少注入脚本: ' + shimFile);
  runScript(zoneFile);
  runScript(shimFile);
}

runScript(path.join(ROOT, 'extension', 'verify', 'verify-fingerprint.js'));

if (!globalThis.TZFingerprint) {
  console.error('verify-fingerprint.js 未挂载 TZFingerprint');
  process.exit(3);
}

const data = globalThis.TZFingerprint.collect(zone);
data.env = {
  mode: mode,
  resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  nodeTZ: process.env.TZ || null,
  shim: globalThis.__DSH_TZ_FIX__ || null
};
fs.writeFileSync(outFile, JSON.stringify(data), 'utf8');
