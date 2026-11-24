#!/usr/bin/env node
/*
 * tests/auto-follow.test.cjs —— 自动跟随代理地区
 *
 * 验证：
 *   · autoFollow 开关的状态模型与校验
 *   · IP 归属地 → 时区的映射调用
 *   · 时区已匹配时不写存储（避免无谓抖动）
 *   · 时区不匹配时自动切换并重新注册内容脚本
 *   · 关闭时不做任何检测
 *   · 查询失败时不影响正常使用
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

/* ---------- 假浏览器环境 ---------- */
function boot(opts) {
  opts = opts || {};
  let stored = {
    settings: Object.assign({
      v: 1, enabled: true, zone: 'America/Los_Angeles', scope: 'chatgpt',
      webrtc: false, font: false, browserProxy: false, proxyPort: 7891, autoFollow: false
    }, opts.settings || {})
  };
  const registered = new Map();
  const calls = { register: [], unregister: [], fetch: [] };
  const listeners = { installed: [], startup: [], message: [], storage: [], alarm: [] };
  const alarms = { created: [], cleared: [] };

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
        async set() {}, async clear() {}
      }
    },
    alarms: {
      async create(name, info) { alarms.created.push([name, info]); },
      async clear(name) { alarms.cleared.push(name); return true; },
      onAlarm: { addListener(fn) { listeners.alarm.push(fn); } }
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

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, Promise, JSON, Object, Array, String, Number, Boolean,
    Math, Date, Intl, Error, RegExp, URL, WeakMap, Function, Reflect, Proxy, Symbol, Map, Set,
    chrome,
    fetch: opts.fetch || (async () => { throw new Error('no network'); }),
    AbortSignal: { timeout: () => undefined },
    importScripts(file) {
      vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, { filename: file });
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });

  return { sandbox, bg: sandbox.__DSH_TZ_BG__, stored, calls, alarms, listeners, chrome };
}

/* 构造一个能返回指定 IP/国家的 fetch */
function makeFetch(ip, country) {
  return async (url) => {
    if (url.indexOf('ipinfo.io') >= 0) {
      return { ok: true, async json() { return { ip, country, region: '', city: '' }; } };
    }
    if (url.indexOf('cloudflare') >= 0) {
      return { ok: true, async text() { return 'ip=' + ip + '\nloc=' + country + '\n'; } };
    }
    throw new Error('unexpected url ' + url);
  };
}

(async () => {
  console.log('== 自动跟随代理地区测试 ==');
  console.log('');

  /* --- 1. 状态模型 --- */
  console.log('--- 1. 状态模型 ---');
  {
    const { bg } = boot();
    check('默认 autoFollow 为 false', bg.DEFAULT_STATE.autoFollow === false);
    check('normalizeState 接受 autoFollow', bg.normalizeState({ autoFollow: true }).autoFollow === true);
    check('校验拒绝非布尔值', bg.validatePatch({ autoFollow: 'yes' }) !== null);
    check('校验接受布尔值', bg.validatePatch({ autoFollow: true }) === null);
  }

  /* --- 2. 国家 → 时区映射 --- */
  console.log('');
  console.log('--- 2. 国家 → 时区映射 ---');
  {
    const { bg } = boot();
    check('JP → Asia/Tokyo', bg.zoneForCountry('JP') === 'Asia/Tokyo', bg.zoneForCountry('JP'));
    check('US → America/Los_Angeles', bg.zoneForCountry('US') === 'America/Los_Angeles');
    check('CN → Asia/Shanghai', bg.zoneForCountry('CN') === 'Asia/Shanghai');
    check('SG → Asia/Singapore', bg.zoneForCountry('SG') === 'Asia/Singapore');
    check('未知国家返回 null', bg.zoneForCountry('ZZ') === null);
    check('空值返回 null', bg.zoneForCountry('') === null);
    check('小写国家码也能识别', bg.zoneForCountry('jp') === 'Asia/Tokyo');
  }

  /* --- 3. 关闭时不检测 --- */
  console.log('');
  console.log('--- 3. 关闭自动跟随时不做检测 ---');
  {
    const { bg } = boot({ settings: { autoFollow: false } });
    const r = await bg.runAutoFollow({ enabled: true, autoFollow: false, zone: 'Asia/Tokyo' });
    check('不检测，返回未检测', r.checked === false, JSON.stringify(r));
  }

  /* --- 4. 时区已匹配则不写存储 --- */
  console.log('');
  console.log('--- 4. 已匹配时不抖动 ---');
  {
    const ctx = boot({ settings: { autoFollow: true, zone: 'Asia/Tokyo' }, fetch: makeFetch('103.62.49.131', 'JP') });
    await new Promise(r => setTimeout(r, 60));
    const regBefore = ctx.calls.register.length;

    const r = await ctx.bg.runAutoFollow({ enabled: true, autoFollow: true, zone: 'Asia/Tokyo' });
    check('检测成功', r.checked === true && !r.error, JSON.stringify(r));
    check('没有切换', r.changed === false, JSON.stringify(r));
    check('没有重复注册内容脚本', ctx.calls.register.length === regBefore,
      regBefore + ' → ' + ctx.calls.register.length);
    check('存储里时区未变', ctx.stored.settings.zone === 'Asia/Tokyo');
  }

  /* --- 5. 时区不匹配则自动切换 --- */
  console.log('');
  console.log('--- 5. IP 变了则自动切换 ---');
  {
    const ctx = boot({ settings: { autoFollow: true, zone: 'America/Los_Angeles' }, fetch: makeFetch('103.62.49.131', 'JP') });
    await new Promise(r => setTimeout(r, 60));
    const regBefore = ctx.calls.register.length;

    const r = await ctx.bg.runAutoFollow({ enabled: true, autoFollow: true, zone: 'America/Los_Angeles' });
    check('检测到变化', r.changed === true, JSON.stringify(r));
    check('从洛杉矶切到东京', r.from === 'America/Los_Angeles' && r.to === 'Asia/Tokyo',
      r.from + ' → ' + r.to);
    check('存储已更新', ctx.stored.settings.zone === 'Asia/Tokyo');
    check('重新注册了内容脚本', ctx.calls.register.length > regBefore,
      regBefore + ' → ' + ctx.calls.register.length);

    const last = ctx.calls.register[ctx.calls.register.length - 1][0];
    check('注入的 zone 文件已是东京', last.js[0] === 'inject/zones/asia_tokyo.js',
      JSON.stringify(last.js));
  }

  /* --- 6. IP 查询失败不影响使用 --- */
  console.log('');
  console.log('--- 6. 查询失败时安全退出 ---');
  {
    const ctx = boot({
      settings: { autoFollow: true, zone: 'America/Los_Angeles' },
      fetch: async () => { throw new Error('network down'); }
    });
    await new Promise(r => setTimeout(r, 60));

    const r = await ctx.bg.runAutoFollow({ enabled: true, autoFollow: true, zone: 'America/Los_Angeles' });
    check('没有抛错', r && typeof r === 'object');
    check('没有切换时区', r.changed !== true);
    check('存储保持原样', ctx.stored.settings.zone === 'America/Los_Angeles');
  }

  /* --- 7. 扩展关闭时不跟随 --- */
  console.log('');
  console.log('--- 7. 扩展关闭时不跟随 ---');
  {
    const ctx = boot({ settings: { enabled: false, autoFollow: true, zone: 'America/Los_Angeles' }, fetch: makeFetch('1.2.3.4', 'JP') });
    await new Promise(r => setTimeout(r, 60));
    const r = await ctx.bg.runAutoFollow({ enabled: false, autoFollow: true, zone: 'America/Los_Angeles' });
    check('扩展关闭时不检测', r.checked === false, JSON.stringify(r));
    check('时区未变', ctx.stored.settings.zone === 'America/Los_Angeles');
  }

  /* --- 8. alarms 同步 --- */
  console.log('');
  console.log('--- 8. 定时校准 ---');
  {
    const ctx = boot({ settings: { autoFollow: true } });
    await new Promise(r => setTimeout(r, 80));
    const createdForAuto = ctx.alarms.created.filter(a => a[0] === 'tz-auto-follow');
    check('开启后创建了定时任务', createdForAuto.length > 0,
      'created: ' + JSON.stringify(ctx.alarms.created));
    if (createdForAuto.length) {
      const period = createdForAuto[createdForAuto.length - 1][1].periodInMinutes;
      check('周期合理（5-120 分钟）', period >= 5 && period <= 120, String(period));
    }
  }

  /* --- 9. 无国家码时不乱切 --- */
  console.log('');
  console.log('--- 9. 识别不出国家时不乱切 ---');
  {
    const ctx = boot({
      settings: { autoFollow: true, zone: 'America/Los_Angeles' },
      fetch: async (url) => {
        if (url.indexOf('ipinfo') >= 0) return { ok: true, async json() { return { ip: '1.2.3.4' }; } };
        if (url.indexOf('cloudflare') >= 0) return { ok: true, async text() { return 'ip=1.2.3.4\nloc=\n'; } };
        throw new Error('x');
      }
    });
    await new Promise(r => setTimeout(r, 60));
    const r = await ctx.bg.runAutoFollow({ enabled: true, autoFollow: true, zone: 'America/Los_Angeles' });
    check('没有切换', r.changed !== true, JSON.stringify(r));
    check('时区保持', ctx.stored.settings.zone === 'America/Los_Angeles');
  }

  console.log('');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
