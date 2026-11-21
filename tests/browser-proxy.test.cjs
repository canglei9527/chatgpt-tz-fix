#!/usr/bin/env node
/*
 * tests/browser-proxy.test.cjs —— 浏览器级强制代理（PAC）测试
 *
 * 验证：
 *   · 开启时调用 chrome.proxy.settings.set，模式为 pac_script
 *   · PAC 脚本只对 ChatGPT 相关域名返回代理，其它返回 DIRECT
 *   · 关闭时调用 clear 恢复系统代理
 *   · 端口可配置
 *   · 非法端口被拒绝
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); fail++; }
}

/* ---------- 假 chrome ---------- */
function makeChrome() {
  const stored = { settings: null };
  const calls = { set: [], clear: [], register: [], unregister: [] };
  const listeners = { installed: [], startup: [], message: [], storage: [] };
  const registered = new Map();

  const chrome = {
    storage: {
      local: {
        async get(k) { return k ? { [k]: stored[k] } : Object.assign({}, stored); },
        async set(o) { Object.assign(stored, o); }
      },
      onChanged: { addListener(fn) { listeners.storage.push(fn); } }
    },
    scripting: {
      async registerContentScripts(list) {
        const ALLOWED = new Set(['id','matches','js','css','runAt','world','allFrames','persistAcrossSessions']);
        for (const s of list) {
          for (const k of Object.keys(s)) {
            if (!ALLOWED.has(k)) throw new Error("Unexpected property: '" + k + "'");
          }
        }
        list.forEach(s => registered.set(s.id, s));
        calls.register.push(list);
      },
      async unregisterContentScripts(o) { (o.ids||[]).forEach(id => registered.delete(id)); calls.unregister.push(o); },
      async getRegisteredContentScripts(o) {
        const ids = (o && o.ids) || [...registered.keys()];
        return ids.filter(i => registered.has(i)).map(i => registered.get(i));
      },
      async executeScript() { return []; }
    },
    proxy: {
      settings: {
        async set(opts) { calls.set.push(JSON.parse(JSON.stringify(opts))); },
        async clear(opts) { calls.clear.push(JSON.parse(JSON.stringify(opts))); }
      }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: { async create() { return { id: 1 }; }, async get(id) { return { id, url: 'https://chatgpt.com/' }; }, async reload() {}, async query() { return []; } },
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (p) => 'chrome-extension://x/' + p,
      onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
      onStartup: { addListener(fn) { listeners.startup.push(fn); } },
      onMessage: { addListener(fn) { listeners.message.push(fn); } }
    }
  };
  return { chrome, calls, stored, listeners };
}

function boot(mock) {
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, Promise, JSON, Object, Array, String, Number, Boolean, Math, Date, Intl,
    Error, RegExp, URL, WeakMap, Function, Reflect, Proxy, Symbol,
    chrome: mock.chrome,
    importScripts(file) {
      vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, { filename: file });
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  return sandbox;
}

/* ---------- PAC 脚本沙盒求值 ---------- */
function evalPac(pacSource, url, host) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(pacSource, sandbox, { filename: 'pac.js' });
  // PAC 里用到的辅助函数
  sandbox.shExpMatch = (str, pattern) => {
    const re = new RegExp('^' + pattern.replace(/[.+^$(){}|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return re.test(str);
  };
  sandbox.isPlainHostName = (h) => h.indexOf('.') < 0;
  return vm.runInContext('FindProxyForURL(' + JSON.stringify(url) + ',' + JSON.stringify(host) + ')', sandbox);
}

(async () => {
  console.log('== 浏览器级强制代理测试 ==');
  console.log('');

  /* --- 1. 默认关闭 --- */
  console.log('--- 默认状态 ---');
  const m0 = makeChrome();
  m0.stored.settings = { v: 1, enabled: true, zone: 'America/Los_Angeles', scope: 'chatgpt' };
  const w0 = boot(m0);
  const bg0 = w0.__DSH_TZ_BG__;
  const st0 = await bg0.readState();
  check('默认 browserProxy 为 false', st0.browserProxy === false, String(st0.browserProxy));
  check('默认 proxyPort 为 7891', st0.proxyPort === 7891, String(st0.proxyPort));
  await new Promise(r => setTimeout(r, 60));
  const clearedOnInit = m0.calls.clear.length > 0;
  check('关闭状态下 init 会 clear 代理', clearedOnInit, 'clear 次数: ' + m0.calls.clear.length);

  /* --- 2. 开启代理 --- */
  console.log('');
  console.log('--- 开启浏览器代理 ---');
  const m1 = makeChrome();
  m1.stored.settings = { v: 1, enabled: true, zone: 'America/Los_Angeles', scope: 'chatgpt', browserProxy: true, proxyPort: 7891 };
  const w1 = boot(m1);
  await new Promise(r => setTimeout(r, 80));

  check('调用了 chrome.proxy.settings.set', m1.calls.set.length > 0, '次数: ' + m1.calls.set.length);
  const setCall = m1.calls.set[m1.calls.set.length - 1];
  check('模式为 pac_script', setCall && setCall.value && setCall.value.mode === 'pac_script',
    JSON.stringify(setCall && setCall.value && setCall.value.mode));
  check('scope 为 regular', setCall && setCall.scope === 'regular', String(setCall && setCall.scope));

  const pac = setCall && setCall.value && setCall.value.pacScript && setCall.value.pacScript.data;
  check('PAC 脚本非空', typeof pac === 'string' && pac.length > 50, String(pac && pac.length));

  /* --- 3. PAC 路由判定 --- */
  console.log('');
  console.log('--- PAC 路由判定 ---');
  const shouldProxy = [
    ['https://chatgpt.com/', 'chatgpt.com'],
    ['https://chatgpt.com/backend-api/x', 'chatgpt.com'],
    ['https://ab.chatgpt.com/', 'ab.chatgpt.com'],
    ['https://cdn.oaistatic.com/x.js', 'cdn.oaistatic.com'],
    ['https://auth.openai.com/', 'auth.openai.com'],
    ['https://chat.openai.com/', 'chat.openai.com'],
    ['https://files.oaiusercontent.com/x', 'files.oaiusercontent.com'],
    ['https://chat.com/', 'chat.com'],
    ['https://sora.com/', 'sora.com']
  ];
  shouldProxy.forEach(([url, host]) => {
    const r = evalPac(pac, url, host);
    check(host + ' → 走代理', r && r.indexOf('PROXY 127.0.0.1:7891') >= 0, r);
  });

  console.log('');
  console.log('--- 不应受影响的域名 ---');
  const shouldDirect = [
    ['https://www.baidu.com/', 'www.baidu.com'],
    ['https://github.com/', 'github.com'],
    ['http://localhost:3000/', 'localhost']
  ];
  shouldDirect.forEach(([url, host]) => {
    const r = evalPac(pac, url, host);
    check(host + ' → DIRECT', r === 'DIRECT', r);
  });

  /* --- 4. 自定义端口 --- */
  console.log('');
  console.log('--- 自定义端口 ---');
  const m2 = makeChrome();
  m2.stored.settings = { v: 1, enabled: true, zone: 'America/Los_Angeles', scope: 'chatgpt', browserProxy: true, proxyPort: 9999 };
  boot(m2);
  await new Promise(r => setTimeout(r, 80));
  const set2 = m2.calls.set[m2.calls.set.length - 1];
  const pac2 = set2 && set2.value && set2.value.pacScript && set2.value.pacScript.data;
  check('端口 9999 写入 PAC', typeof pac2 === 'string' && pac2.indexOf('127.0.0.1:9999') >= 0);

  /* --- 5. 关闭后恢复 --- */
  console.log('');
  console.log('--- 关闭后恢复 ---');
  const m3 = makeChrome();
  const w3 = boot(m3);
  const bg3 = w3.__DSH_TZ_BG__;
  await new Promise(r => setTimeout(r, 80));
  m3.calls.clear.length = 0;

  await bg3.handleMessage({ type: 'setState', patch: { browserProxy: true } }, {});
  check('开启后调用 set', m3.calls.set.length > 0);

  await bg3.handleMessage({ type: 'setState', patch: { browserProxy: false } }, {});
  check('关闭后调用 clear', m3.calls.clear.length > 0, 'clear: ' + m3.calls.clear.length);

  /* --- 6. 非法端口被拒 --- */
  console.log('');
  console.log('--- 参数校验 ---');
  check('端口 0 被拒', bg3.validatePatch({ proxyPort: 0 }) !== null);
  check('端口 70000 被拒', bg3.validatePatch({ proxyPort: 70000 }) !== null);
  check('端口非整数被拒', bg3.validatePatch({ proxyPort: 1.5 }) !== null);
  check('合法端口通过', bg3.validatePatch({ proxyPort: 7891 }) === null);

  console.log('');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail === 0 ? 0 : 1;
})();
