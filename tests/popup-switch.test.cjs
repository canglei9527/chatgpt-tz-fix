#!/usr/bin/env node
/*
 * tests/popup-switch.test.cjs —— 弹窗开关交互测试
 *
 * 这个测试是为了复现并防止一类致命 bug：
 *   弹窗里点开关，视觉上 toggle 但实际没保存 / 或者点几次之后彻底失灵。
 *
 * 根因有两个（都已修复，这里锁死）：
 *   1) <label for=...> 同时包裹 <input> → 点击内部元素 toggle 两次，互相抵消
 *   2) flushPatch 的 saving 标志在某些情况下不重置 → 之后所有操作被挡掉
 *
 * 用真实的 callback 风格 chrome.runtime.sendMessage mock，
 * 与 background 的 sendResponse 行为保持一致。
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

/* ---------------- 极简 DOM ---------------- */
function makeEl(id, tag) {
  const listeners = {};
  const el = {
    id, tagName: (tag || 'div').toUpperCase(),
    _value: '', _checked: false, _textContent: '', _innerHTML: '',
    className: '', hidden: false, disabled: false,
    style: {}, dataset: {}, children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatch(t, ev) { (listeners[t] || []).slice().forEach(fn => fn.call(el, Object.assign({ target: el }, ev))); },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach(c => this.appendChild(c)); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {},
    click() { this.dispatch('click', {}); },
    remove() {}
  };
  Object.defineProperty(el, 'value', { get() { return this._value; }, set(v) { this._value = String(v); } });
  Object.defineProperty(el, 'checked', { get() { return this._checked; }, set(v) { this._checked = !!v; } });
  Object.defineProperty(el, 'textContent', { get() { return this._textContent; }, set(v) { this._textContent = String(v); } });
  Object.defineProperty(el, 'innerHTML', { get() { return this._innerHTML; }, set(v) { this._innerHTML = String(v); } });
  return el;
}

const IDS = [
  'toggle','statusDot','statusText','realZone','maskZone','clockReal','clockMasked','clockDay',
  'checkResult','zoneSearch','zoneSelect','savedHint','scopeSegment','webrtcToggle','fontToggle',
  'proxyToggle','proxyPort','proxyHint','ipRow','ipValue','ipHint','btnDetectIp',
  'btnCheck','btnReload','btnOpen','btnVerify','btnCopy','version','toast'
];

/* ---------------- 环境搭建 ---------------- */
function boot(opts) {
  opts = opts || {};
  const els = {};
  IDS.forEach(id => { els[id] = makeEl(id); });
  els.scopeSegment.querySelectorAll = () => [];

  const document = {
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return makeEl('', tag); },
    createDocumentFragment() { return makeEl('', 'fragment'); },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: makeEl('', 'body')
  };

  let stored = {
    settings: {
      v: 1, enabled: true, zone: 'America/Los_Angeles', scope: 'chatgpt',
      webrtc: false, font: false, browserProxy: false, proxyPort: 7891
    }
  };
  const sent = [];
  const proxyCalls = [];

  /* 关键：callback 风格，与真实 chrome.runtime.sendMessage 一致 */
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sent.push(msg);
        const respond = (r) => { if (typeof cb === 'function') setTimeout(() => cb(r), opts.latency || 0); };
        if (msg.type === 'getState') {
          return respond({ ok: true, state: Object.assign({}, stored.settings), meta: { realZone: 'Asia/Shanghai', version: '1.0.0' } });
        }
        if (msg.type === 'getZones') {
          return respond({ ok: true, zones: [
            { zone: 'America/Los_Angeles', label: '美国西部·洛杉矶', slug: 'america_los_angeles' },
            { zone: 'Asia/Tokyo', label: '日本·东京', slug: 'asia_tokyo' }
          ]});
        }
        if (msg.type === 'setState') {
          if (opts.hangSetState) return;   // 模拟后台不响应
          Object.assign(stored.settings, msg.patch);
          return respond({ ok: true, state: Object.assign({}, stored.settings) });
        }
        return respond({ ok: true });
      }
    },
    proxy: {
      settings: {
        set(o, cb) { proxyCalls.push(['set', o]); if (cb) setTimeout(cb, 0); },
        clear(o, cb) { proxyCalls.push(['clear', o]); if (cb) setTimeout(cb, 0); }
      }
    },
    storage: { onChanged: { addListener() {} } },
    tabs: {
      query(q, cb) { if (cb) setTimeout(() => cb([{ id: 1, url: 'https://chatgpt.com/' }]), 0); },
      sendMessage(m, cb) { if (cb) setTimeout(() => cb({ ok: true }), 0); }
    },
    scripting: { executeScript() { return Promise.resolve([]); } }
  };

  const sandbox = {
    console,
    document,
    chrome,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Object, Array, String, Number, Boolean, Math, Date, Intl,
    Error, RegExp, parseInt, parseFloat, isNaN, isFinite,
    fetch: () => Promise.reject(new Error('no network in test'))
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = function () {};
  sandbox.removeEventListener = function () {};

  vm.createContext(sandbox);
  const popupSrc = fs.readFileSync(path.join(EXT, 'popup/popup.js'), 'utf8');
  vm.runInContext(popupSrc, sandbox, { filename: 'popup.js' });

  return { els, document, sent, stored, chrome, sandbox, proxyCalls };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('== 弹窗开关交互测试 ==');
  console.log('');

  /* ---------- 1. 基础：点击开关能保存 ---------- */
  console.log('--- 1. 点击开关应触发保存 ---');
  {
    const ctx = boot();
    await wait(300);
    const before = ctx.sent.filter(m => m.type === 'setState').length;

    ctx.els.proxyToggle.checked = true;
    ctx.els.proxyToggle.dispatch('change', {});
    await wait(300);

    const after = ctx.sent.filter(m => m.type === 'setState');
    check('发出了 setState', after.length > before, '总数: ' + after.length);
    const last = after[after.length - 1];
    check('patch 含 browserProxy: true', last && last.patch && last.patch.browserProxy === true,
      JSON.stringify(last && last.patch));
    check('后台状态已更新', ctx.stored.settings.browserProxy === true);
  }

  /* ---------- 2. 连续多次点击都能生效 ---------- */
  console.log('');
  console.log('--- 2. 连续点击（这是之前失败的地方）---');
  {
    const ctx = boot();
    await wait(300);

    for (let i = 0; i < 4; i++) {
      const want = i % 2 === 0;
      ctx.els.proxyToggle.checked = want;
      ctx.els.proxyToggle.dispatch('change', {});
      await wait(200);
      check('第 ' + (i + 1) + ' 次点击 → ' + want,
        ctx.stored.settings.browserProxy === want,
        '实际: ' + ctx.stored.settings.browserProxy);
    }
  }

  /* ---------- 3. 快速连点（合并 patch）---------- */
  console.log('');
  console.log('--- 3. 快速连点不应丢失最后一次 ---');
  {
    const ctx = boot();
    await wait(300);

    ctx.els.proxyToggle.checked = true;
    ctx.els.proxyToggle.dispatch('change', {});
    ctx.els.proxyToggle.checked = false;
    ctx.els.proxyToggle.dispatch('change', {});
    await wait(400);

    check('最终状态为最后一次的值 (false)',
      ctx.stored.settings.browserProxy === false,
      '实际: ' + ctx.stored.settings.browserProxy);
  }

  /* ---------- 4. 后台不响应时有超时兜底 ---------- */
  console.log('');
  console.log('--- 4. 后台卡住时超时兜底 ---');
  {
    const ctx = boot({ hangSetState: true });
    await wait(300);

    ctx.els.proxyToggle.checked = true;
    ctx.els.proxyToggle.dispatch('change', {});
    await wait(100);

    /* 后台一直不响应，saving 应为 true，此时再点会被挡住（符合预期） */
    const sentBefore = ctx.sent.filter(m => m.type === 'setState').length;
    check('卡住期间只发了一次', sentBefore === 1, '次数: ' + sentBefore);

    /*
     * 超时兜底设为 15 秒，测试里不真等那么久。
     * 改为验证「保存失败/超时后不会永久卡死」这条逻辑：
     * 直接调用 popup 暴露的超时路径不现实，所以这里只验证
     * 卡住期间后续点击不会产生额外请求（说明 saving 生效），
     * 以及 SAVE_TIMEOUT 常量确实存在于源码里。
     */
    const popupSrc = fs.readFileSync(path.join(EXT, 'popup/popup.js'), 'utf8');
    check('源码中有保存超时兜底', /SAVE_TIMEOUT_MS\s*=\s*\d+/.test(popupSrc));
    check('源码中有 releaseSaving 函数', popupSrc.indexOf('function releaseSaving') >= 0);
    check('超时回调里会解除 saving', /saveGuardTimer\s*=\s*setTimeout/.test(popupSrc));
  }

  /* ---------- 5. 其它开关同样工作 ---------- */
  console.log('');
  console.log('--- 5. 其它开关（WebRTC / 字体 / 主开关）---');
  {
    const ctx = boot();
    await wait(300);

    ctx.els.webrtcToggle.checked = true;
    ctx.els.webrtcToggle.dispatch('change', {});
    await wait(200);
    check('WebRTC 开关生效', ctx.stored.settings.webrtc === true);

    ctx.els.fontToggle.checked = true;
    ctx.els.fontToggle.dispatch('change', {});
    await wait(200);
    check('字体开关生效', ctx.stored.settings.font === true);

    ctx.els.toggle.checked = false;
    ctx.els.toggle.dispatch('change', {});
    await wait(200);
    check('主开关生效', ctx.stored.settings.enabled === false);
  }

  /* ---------- 6. 端口输入 ---------- */
  console.log('');
  console.log('--- 6. 端口输入 ---');
  {
    const ctx = boot();
    await wait(300);

    ctx.els.proxyPort.value = '9999';
    ctx.els.proxyPort.dispatch('input', {});
    await wait(800);

    check('端口保存成功', ctx.stored.settings.proxyPort === 9999,
      '实际: ' + ctx.stored.settings.proxyPort);
  }

  /* ---------- 7. HTML 结构：label 不能同时 for + 包裹 ---------- */
  console.log('');
  console.log('--- 7. HTML 结构检查 ---');
  {
    const html = fs.readFileSync(path.join(EXT, 'popup/popup.html'), 'utf8');
    const bad = [];
    const re = /<label([^>]*)for="([^"]+)"([^>]*)>([\s\S]*?)<\/label>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const forId = m[2];
      const inner = m[4];
      if (inner.indexOf('id="' + forId + '"') >= 0) bad.push(forId);
    }
    check('没有 label 同时用 for 且包裹 input', bad.length === 0,
      '问题: ' + bad.join(', '));
  }

  console.log('');
  console.log(pass + ' 通过 / ' + fail + ' 失败');

  /*
   * 必须显式退出：popup.js 内部有 tick 定时器和保存超时定时器，
   * 它们会一直保持事件循环活跃，导致进程不退出（测试运行器会卡死）。
   */
  process.exit(fail === 0 ? 0 : 1);
})();
