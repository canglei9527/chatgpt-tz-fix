#!/usr/bin/env node
/*
 * tests/verify-page.test.cjs —— 自检页的集成测试
 *
 * 覆盖三类问题：
 *  1. verify.js 的「参考算法」是否与浏览器原生 ICU 行为一致
 *     （用真身环境采集数据 → 用参考算法算期望 → 必须全绿）
 *  2. 注入引擎自检能否识别出错误的环境（把真身数据当成别的时区去比对，必须报错）
 *  3. verify-bootstrap.js / verify-fingerprint.js 的加载顺序与契约是否正确
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tzfix-verify-'));

const failures = [];
const notes = [];

function ok(name) { notes.push('  ✓ ' + name); }
function bad(name, detail) {
  failures.push(name + (detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''));
  notes.push('  ✗ ' + name);
}

function assert(name, condition, detail) {
  if (condition) ok(name); else bad(name, detail);
}

/* ---------- 1. 在沙箱里加载 verify.js，取出测试钩子 ---------- */

function loadVerifyModule() {
  const el = () => ({
    addEventListener() {}, appendChild() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {} },
    style: {}, setAttribute() {}, querySelector: () => el(), textContent: '', className: '', disabled: false, value: ''
  });
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Blob, URLSearchParams,
    document: {
      readyState: 'loading',
      addEventListener() {},
      createElement: () => el(),
      getElementById: () => el(),
      body: el()
    },
    chrome: {
      runtime: { lastError: null, sendMessage() {}, getURL: (p) => 'chrome-extension://test/' + p },
      storage: { onChanged: { addListener() {} } },
      tabs: { query() {}, reload() {}, create() {} },
      scripting: { executeScript() {} }
    },
    location: { href: 'chrome-extension://test/verify/verify.html' },
    navigator: { userAgent: 'node' }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension/verify/verify.js'), 'utf8'), sandbox, {
    filename: 'verify.js'
  });
  return sandbox.TZVerifyTest;
}

/* ---------- 2. 子进程采集「真身环境」数据 ---------- */

function probe(zone, slug, mode) {
  const out = path.join(TMP, mode + '-' + slug + '.json');
  const fd = fs.openSync(out, 'w');
  const res = spawnSync(NODE, [
    path.join(ROOT, 'tests', 'realm-probe.cjs'), zone, slug, mode, out
  ], {
    stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, mode === 'native' ? { TZ: zone } : { TZ: 'Asia/Shanghai' }),
    timeout: 120000
  });
  fs.closeSync(fd);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error('采集失败 ' + zone + '/' + mode + '，退出码 ' + res.status);
  }
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

/* ---------- 3. bootstrap 契约测试 ---------- */

async function testBootstrapOrder() {
  const sandbox = {
    console,
    location: { search: '?zone=America%2FLos_Angeles&slug=america_los_angeles' },
    URLSearchParams,
    document: {
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      createElement(tag) {
        return {
          tag,
          src: '',
          onload: null,
          onerror: null,
          parent: null
        };
      }
    }
  };
  const appended = [];
  const waiters = [];
  sandbox.setTimeout = (fn) => { waiters.push(fn); return 0; };
  sandbox.document.head = {
    appendChild(el) {
      appended.push(el.src);
      waiters.push(() => { if (el.onload) el.onload(); });
    }
  };
  sandbox.document.documentElement = sandbox.document.head;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension/verify/verify-bootstrap.js'), 'utf8'), sandbox, {
    filename: 'verify-bootstrap.js'
  });

  // 逐个执行排队的回调（等价浏览器里 script.onload 依次触发）
  let guard = 0;
  while (waiters.length && guard < 100) {
    const fn = waiters.shift();
    fn();
    guard += 1;
  }

  assert('bootstrap 依次加载 zone → shim → fingerprint',
    appended.length === 3 &&
    appended[0].endsWith('inject/zones/america_los_angeles.js') &&
    appended[1].endsWith('inject/tz-shim.js') &&
    appended[2].endsWith('verify-fingerprint.js'),
    '实际顺序：' + JSON.stringify(appended));

  const ready = sandbox.__TZF_READY__;
  assert('bootstrap 完成后写 __TZF_READY__', !!(ready && ready.ok), JSON.stringify(ready || null));
}

/* ---------- 4. 参考算法对拍 ---------- */

function engineReport(refModule, data, zone, opts) {
  return refModule.reference.analyse(data, zone, opts);
}

function summarise(report) {
  return report.groups
    .filter((g) => !g.ok())
    .map((g) => g.name + ' (' + (g.total - g.failed) + '/' + g.total + ')：\n' +
      g.details.map((d) => '        ' + d.replace(/\n/g, '\n        ')).join('\n'))
    .join('\n');
}

async function main() {
  const refModule = loadVerifyModule();
  assert('verify.js 暴露测试钩子', !!refModule && !!refModule.reference, '未拿到 TZVerifyTest');

  // 注意：ICU 只认识规范名（例如印度时区是 Asia/Calcutta，没有 Asia/Kolkata），
  // 这里必须用 shared/zones.js 里真实存在的 ID，否则时区文件不存在会采集失败。
  const zones = [
    ['America/Los_Angeles', 'america_los_angeles'],
    ['America/New_York', 'america_new_york'],
    ['Europe/London', 'europe_london'],
    ['Asia/Tokyo', 'asia_tokyo'],
    ['Asia/Shanghai', 'asia_shanghai'],
    ['Asia/Calcutta', 'asia_calcutta'],
    ['Australia/Sydney', 'australia_sydney'],
    ['Europe/Berlin', 'europe_berlin'],
    ['America/St_Johns', 'america_st_johns'],
    ['Pacific/Chatham', 'pacific_chatham']
  ];

  zones.forEach(([zone, slug]) => {
    let data;
    try {
      data = probe(zone, slug, 'native');
    } catch (e) {
      bad('采集原生环境数据 ' + zone, e.message);
      return;
    }
    const report = engineReport(refModule, data, zone, { skipMarker: true });
    assert('参考算法与浏览器原生一致 · ' + zone, report.ok, summarise(report));

    // 反向验证：同一份数据用错时区比对必须失败，确保测试不是空转
    const wrong = engineReport(refModule, data, zone === 'Asia/Shanghai' ? 'America/Los_Angeles' : 'Asia/Shanghai', { skipMarker: true });
    assert('错配时区会被识别 · ' + zone, !wrong.ok, '把 ' + zone + ' 的数据当成另一个时区比对，竟然全部通过');
  });

  await testBootstrapOrder();

  fs.rmSync(TMP, { recursive: true, force: true });

  process.stdout.write('== 自检页集成测试 ==\n');
  notes.forEach((n) => process.stdout.write(n + '\n'));

  if (failures.length) {
    process.stdout.write('\n✗ 失败 ' + failures.length + ' 项：\n');
    failures.forEach((f) => process.stdout.write('  - ' + f + '\n'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✓ 全部通过（' + notes.length + ' 项断言）\n');
}

main().catch((e) => {
  process.stdout.write('✗ 测试异常：' + (e && e.stack || e) + String.fromCharCode(10));
  process.exitCode = 1;
});
