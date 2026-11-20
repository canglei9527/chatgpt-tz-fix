#!/usr/bin/env node
/*
 * tools/build.cjs —— 构建 / 校验脚本
 *
 * 1. 把 src/tz-shim.js 拷贝到 extension/inject/tz-shim.js（注入脚本的最终形态）
 * 2. 校验扩展目录的必要文件是否齐全、manifest 是否合法
 * 3. 组装 dist/chatgpt-tz-fix/（可直接「加载已解压的扩展程序」的发布目录）
 *
 * 用法：node tools/build.cjs [--no-dist]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist', 'chatgpt-tz-fix');
const SHIM_SRC = path.join(ROOT, 'src', 'tz-shim.js');
const SHIM_DST = path.join(EXT, 'inject', 'tz-shim.js');

const errors = [];
const notes = [];

function log(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { errors.push(msg); }
function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }
function exists(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

/* ---------- 1. 拷贝注入脚本 ---------- */
function copyShim() {
  if (!exists(SHIM_SRC)) {
    fail('缺少核心脚本 src/tz-shim.js');
    return;
  }
  const source = fs.readFileSync(SHIM_SRC, 'utf8');
  const banner = [
    '/*',
    ' * ⚠ 本文件由 tools/build.cjs 从 src/tz-shim.js 自动生成，请勿直接修改。',
    ' * 修改请编辑 src/tz-shim.js 后重新运行：node tools/build.cjs',
    ' */'
  ].join('\n');
  fs.mkdirSync(path.dirname(SHIM_DST), { recursive: true });
  fs.writeFileSync(SHIM_DST, banner + '\n' + source, 'utf8');
  notes.push('注入脚本已生成：' + rel(SHIM_DST) + '（' + Buffer.byteLength(source, 'utf8') + ' 字节）');

  const banned = [/\beval\s*\(/, /new\s+Function\s*\(/];
  banned.forEach(function (re) {
    if (re.test(source)) fail('src/tz-shim.js 含 CSP 不安全写法：' + re);
  });
  if (/^\s*(import|export)\s/m.test(source)) fail('src/tz-shim.js 不能使用 ES module 语法（内容脚本以 classic script 注入）');
}

/* ---------- 2. 校验扩展结构 ---------- */
function readManifest() {
  const p = path.join(EXT, 'manifest.json');
  if (!exists(p)) { fail('缺少 extension/manifest.json'); return null; }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail('extension/manifest.json 不是合法 JSON：' + e.message);
    return null;
  }
  if (manifest.manifest_version !== 3) fail('manifest_version 必须为 3');
  return manifest;
}

function checkManifest(manifest) {
  if (!manifest) return;

  const sw = manifest.background && manifest.background.service_worker;
  if (!sw) fail('manifest 缺少 background.service_worker');
  else if (!exists(path.join(EXT, sw))) fail('background.service_worker 指向的文件不存在：' + sw);

  const popup = manifest.action && manifest.action.default_popup;
  if (!popup) fail('manifest 缺少 action.default_popup');
  else if (!exists(path.join(EXT, popup))) fail('action.default_popup 指向的文件不存在：' + popup);

  const icons = manifest.icons || {};
  ['16', '32', '48', '128'].forEach(function (size) {
    const p = icons[size];
    if (!p) fail('manifest.icons 缺少 ' + size + 'px 图标');
    else if (!exists(path.join(EXT, p))) fail('图标文件不存在：' + p);
  });

  const perms = manifest.permissions || [];
  ['storage', 'scripting'].forEach(function (p) {
    if (perms.indexOf(p) < 0) fail('manifest.permissions 缺少 ' + p);
  });
  const hosts = manifest.host_permissions || [];
  if (hosts.indexOf('<all_urls>') < 0) fail('manifest.host_permissions 缺少 <all_urls>');

  const war = manifest.web_accessible_resources || [];
  const allResources = war.reduce(function (acc, item) { return acc.concat(item.resources || []); }, []);
  ['verify/verify.html', 'verify/verify.js', 'inject/tz-shim.js'].forEach(function (r) {
    if (allResources.indexOf(r) < 0) fail('web_accessible_resources 缺少 ' + r);
  });
}

function checkInjectBundle() {
  const dir = path.join(EXT, 'inject', 'zones');
  if (!fs.existsSync(dir)) { fail('缺少 extension/inject/zones 目录'); return; }
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); });
  if (files.length < 100) fail('inject/zones 下的时区文件数量异常：' + files.length);

  const zonesJs = path.join(EXT, 'shared', 'zones.js');
  if (!exists(zonesJs)) { fail('缺少 extension/shared/zones.js'); return; }

  // 每个时区文件的 slug 必须能在 shared/zones.js 里找到，且内容格式正确
  const shared = fs.readFileSync(zonesJs, 'utf8');
  let ok = 0;
  files.forEach(function (f) {
    const slug = f.replace(/\.js$/, '');
    if (shared.indexOf('"' + slug + '"') < 0) fail('zones.js 中缺少 slug：' + slug);
    else ok += 1;
    /*
     * 校验方式：实际执行该文件、检查变量值与可枚举性。
     * 不要用字符串正则比对模板——生成格式一改（例如改用 defineProperty
     * 让变量不可枚举）这种校验就会全线误报。
     */
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      const sandbox = { globalThis: null };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(body, sandbox, { filename: f });
      const value = sandbox.__DSH_TZ_FIX_ZONE__;
      if (typeof value !== 'string' || !value) {
        fail('时区文件没有设置 __DSH_TZ_FIX_ZONE__：' + f);
      } else if (Object.keys(sandbox).indexOf('__DSH_TZ_FIX_ZONE__') >= 0) {
        fail('时区变量是可枚举的（页面可探测到）：' + f);
      }
    } catch (err) {
      fail('时区文件执行失败：' + f + ' — ' + (err && err.message));
    }
  });
  notes.push('时区文件：' + ok + '/' + files.length + ' 与 shared/zones.js 一致');
}

function checkVerifyPage() {
  const pageDir = path.join(EXT, 'verify');
  const required = ['verify.html', 'verify.css', 'verify.js', 'verify-bootstrap.html', 'verify-bootstrap.js', 'verify-fingerprint.js'];
  required.forEach(function (f) {
    if (!exists(path.join(pageDir, f))) fail('自检页缺少文件：verify/' + f);
  });
  const html = exists(path.join(pageDir, 'verify.html')) ? fs.readFileSync(path.join(pageDir, 'verify.html'), 'utf8') : '';
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)) {
    fail('verify.html 含内联 <script>，MV3 CSP 下会被拒绝执行');
  }
}

function checkNoStrayFiles() {
  const stray = ['node_modules', '.git', 'package-lock.json'];
  stray.forEach(function (name) {
    if (fs.existsSync(path.join(EXT, name))) fail('extension 目录不应包含 ' + name);
  });
}

/* ---------- 3. 组装 dist ---------- */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (entry) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  });
}

function buildDist() {
  fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(EXT, DIST);
  notes.push('发布目录已生成：' + rel(DIST));
}

/* ---------- main ---------- */
function main() {
  const args = process.argv.slice(2);
  log('== 构建 ChatGPT 时区修复扩展 ==');

  copyShim();

  const manifest = readManifest();
  checkManifest(manifest);
  checkInjectBundle();
  checkVerifyPage();
  checkNoStrayFiles();

  if (errors.length === 0 && args.indexOf('--no-dist') < 0) buildDist();

  notes.forEach(function (n) { log('  · ' + n); });

  if (errors.length) {
    log('');
    log('✗ 构建失败，共 ' + errors.length + ' 项：');
    errors.forEach(function (e) { log('  - ' + e); });
    process.exitCode = 1;
    return;
  }
  log('');
  log('✓ 构建通过。');
  if (args.indexOf('--no-dist') < 0) {
    log('  在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」→ 选择：');
    log('  ' + DIST);
  }
}

main();
