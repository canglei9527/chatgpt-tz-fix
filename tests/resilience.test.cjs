#!/usr/bin/env node
/*
 * tests/resilience.test.cjs —— 卡死场景防护
 *
 * 这个测试是为了防止一类让用户以为「扩展坏了」的 bug：
 *   点扩展图标 → 弹窗一片空白 → 以为卡死 → 实际上是在等一个永不返回的 Promise。
 *
 * 两个真实场景（都已在 Chrome 里观察到）：
 *   1. MV3 service worker 被浏览器回收 → chrome.runtime.sendMessage 永不回调
 *   2. 代理节点不通 → fetch 挂起几十秒
 *
 * 要求：无论后台/网络怎样，弹窗都必须在几秒内渲染出可用界面。
 */
'use strict';

const path = require('path');
const EXT = path.resolve(__dirname, '../extension');

const fs = require('fs');
const vm = require('vm');


/* 模拟：后台 service worker 完全不响应（模拟被回收） */
function makeChrome(hang) {
  return {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (hang) return;   // 永不回调
        setTimeout(() => cb({ ok: true, state: { v:1, enabled:true, zone:'Asia/Tokyo', scope:'chatgpt',
          webrtc:false, font:false, browserProxy:false, proxyPort:7891, autoFollow:true },
          meta: { realZone:'Asia/Shanghai', version:'1.0.0' } }), 0);
      },
      getManifest: () => ({ version: '1.0.0' })
    },
    storage: { onChanged: { addListener: () => {} } },
    tabs: { query: (q, cb) => { if (!hang) setTimeout(() => cb([]), 0); } }
  };
}

function makeDom() {
  const els = {};
  const mk = (id) => ({
    id, style:{}, dataset:{}, children:[],
    classList: { _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c,on){on?this._s.add(c):this._s.delete(c);}, contains(c){return this._s.has(c);} },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){},
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    setAttribute(){}, getAttribute(){ return null; }, focus(){}, blur(){}, remove(){},
    textContent:'', innerHTML:'', value:'', checked:false, className:'', hidden:false, disabled:false
  });
  return {
    getElementById(id) { if (!els[id]) els[id] = mk(id); return els[id]; },
    createElement(){ return mk(''); },
    createDocumentFragment(){ return mk(''); },
    addEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; },
    body: mk('body'),
    readyState: 'complete',
    _els: els
  };
}

function boot(hang) {
  const errors = [];
  const document = makeDom();
  const sandbox = {
    console: { warn:(...a)=>errors.push('warn: '+a.join(' ')), error:(...a)=>errors.push('error: '+a.join(' ')), log(){} },
    document, chrome: makeChrome(hang),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Object, Array, String, Number, Boolean, Math, Date, Intl,
    Error, RegExp, parseInt, parseFloat, isNaN, isFinite, Map, Set, WeakMap,
    AbortController: globalThis.AbortController,
    fetch: () => new Promise(() => {}),   // 永不 resolve（模拟网络挂起）
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};

  vm.createContext(sandbox);

  // 按 popup.html 顺序加载
  const html = fs.readFileSync(path.join(EXT, 'popup/popup.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  for (const s of scripts) {
    const p = path.resolve(path.join(EXT, 'popup'), s);
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: s });
  }
  return { sandbox, document, errors };
}

(async () => {
  console.log('== 卡死场景模拟 ==');
  console.log('');

  let pass = 0, fail = 0;
  const check = (n, c, d) => { if (c) { console.log('  ✓ ' + n); pass++; } else { console.log('  ✗ ' + n + (d?'  '+d:'')); fail++; } };

  /* 场景 1：后台完全不响应 */
  console.log('--- 场景 1：后台 SW 被回收，sendMessage 永不回调 ---');
  {
    const ctx = boot(true);
    const t0 = Date.now();
    await new Promise(r => setTimeout(r, 6500));  // 等 send 超时（5s）+ 余量

    const statusText = ctx.document._els.statusText ? ctx.document._els.statusText.textContent : '';
    const elapsed = Date.now() - t0;
    check('弹窗在 6.5 秒内完成渲染（没有永久卡住）', elapsed > 5000 && elapsed < 7000, elapsed + 'ms');
    check('状态文字已被填充（不空白）', statusText.length > 0, '实际: ' + JSON.stringify(statusText));
    console.log('     statusText = ' + JSON.stringify(statusText).slice(0, 80));
  }

  /* 场景 2：网络 fetch 挂起 */
  console.log('');
  console.log('--- 场景 2：fetch 永久挂起（代理不通）---');
  {
    const ctx = boot(false);   // 后台正常
    await new Promise(r => setTimeout(r, 8500));

    const ipText = ctx.document._els.ipValue ? ctx.document._els.ipValue.textContent : '';
    check('IP 区域没有卡在"查询中…"', ipText !== '查询中…', '实际: ' + JSON.stringify(ipText));
    console.log('     ipValue = ' + JSON.stringify(ipText).slice(0, 60));
  }

  console.log('');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
