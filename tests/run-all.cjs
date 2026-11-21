#!/usr/bin/env node
/*
 * tests/run-all.cjs —— 一键运行全部测试
 *
 * 用法：node tests/run-all.cjs
 * 退出码：全部通过为 0，否则为 1
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

const SUITES = [
  { file: 'tests/ui-mock.test.cjs', name: '扩展外壳（manifest / background / popup）' },
  { file: 'tests/verify-page.test.cjs', name: '自检页参考算法 vs 浏览器原生' },
  { file: 'tests/webrtc-guard.test.cjs', name: 'WebRTC 本机 IP 防泄露' },
  { file: 'tests/ip-zone-map.test.cjs', name: '出口 IP → 时区映射' },
  { file: 'tests/font-guard.test.cjs', name: '中文字体指纹模糊' },
  { file: 'tests/browser-proxy.test.cjs', name: '浏览器级强制代理（PAC）' },
  { file: 'tests/popup-switch.test.cjs', name: '弹窗开关交互' },
  { file: 'tests/shim-selfcheck.cjs', name: '伪装脚本 vs 真身差分对拍' }
];

/**
 * 读取子进程日志。
 * 直接 readFileSync(..., 'utf8') 在日志被 PowerShell 重定向写成 UTF-16 时会读成乱码，
 * 进而匹配不到 "ALL OK" 之类的成功标记，造成假失败。
 */
function readLog(file) {
  const buf = fs.readFileSync(file);
  if (buf.length === 0) return '';
  // UTF-16LE BOM
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le');
  // 偶数位大量 0x00 说明是 UTF-16LE（无 BOM）
  let zeros = 0;
  const probe = Math.min(buf.length, 400);
  for (let i = 1; i < probe; i += 2) if (buf[i] === 0) zeros += 1;
  if (zeros > probe / 4) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function runSuite(suite) {
  const abs = path.join(ROOT, suite.file);
  if (!fs.existsSync(abs)) {
    return { ok: false, skipped: true, output: '未找到测试文件' };
  }
  const logFile = path.join(ROOT, 'tests', '.tmp', path.basename(suite.file) + '.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'w');
  const res = spawnSync(NODE, [abs], { stdio: ['ignore', fd, fd], timeout: 600000, cwd: ROOT });
  fs.closeSync(fd);
  const output = readLog(logFile);
  return { ok: res.status === 0, code: res.status, output: output };
}

function main() {
  const started = Date.now();
  let failed = 0;

  process.stdout.write('\n══════════════════════════════════════════════\n');
  process.stdout.write('  ChatGPT 时区修复 · 测试\n');
  process.stdout.write('══════════════════════════════════════════════\n');

  SUITES.forEach(function (suite, index) {
    process.stdout.write('\n[' + (index + 1) + '/' + SUITES.length + '] ' + suite.name + '\n');
    const result = runSuite(suite);
    if (result.skipped) {
      process.stdout.write('  ⊘ ' + result.output + '\n');
      return;
    }
    if (result.ok) {
      const lines = result.output.split(/\r?\n/).filter(function (line) { return /✓ 全部通过|ALL OK|全部通过/.test(line); });
      process.stdout.write('  ✓ 通过' + (lines.length ? ' — ' + lines[lines.length - 1].trim() : '') + '\n');
    } else {
      failed += 1;
      process.stdout.write('  ✗ 失败（退出码 ' + result.code + '）\n');
      process.stdout.write(result.output.split(/\r?\n/).slice(-40).map(function (line) { return '    ' + line; }).join('\n') + '\n');
    }
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write('\n──────────────────────────────────────────────\n');
  if (failed) {
    process.stdout.write('✗ ' + failed + ' 个测试套件失败（用时 ' + seconds + 's）\n\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('✓ 全部测试通过（用时 ' + seconds + 's）\n\n');
}

main();
