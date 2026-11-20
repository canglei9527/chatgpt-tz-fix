#!/usr/bin/env node
/*
 * tests/shim-selfcheck.cjs —— 伪装脚本 vs 真身的「对抗式」差分对拍
 *
 * 设计原则
 *   · 期望值一律来自真身：子进程 env TZ=<zone> 的原生 Node（同一套 ICU tzdata），
 *     绝不从 src/tz-shim.js 的实现里推导期望值。
 *   · 两组跑完全相同的探针：
 *       native —— TZ=<zone>，不加载任何伪装脚本
 *       shim   —— TZ=<hostTz>（与被测时区不同），按内容脚本顺序执行 zone 文件 + tz-shim.js
 *   · 本环境管道 stdio 受限：子进程一律用 fs.openSync 的文件描述符重定向，
 *     结果写成 JSON 文件后由父进程读回比对。
 *
 * 用法
 *   node tests/shim-selfcheck.cjs                  # 默认 14 个时区（含全字段对拍）
 *   node tests/shim-selfcheck.cjs --quick          # 3 个时区
 *   node tests/shim-selfcheck.cjs --all-zones      # 额外把 zones/ 下全部时区跑一遍冒烟对拍
 *   node tests/shim-selfcheck.cjs --zone Asia/Tokyo#America/New_York   # 指定 zone#hostTz
 *   环境变量：DSH_NODE=<node>  DSH_SHIM_PATH=<shim>  DSH_KEEP=1（保留临时目录）
 *
 * 退出码：0 = 全部通过；1 = 有硬差异 / 结构断言失败 / 环境不可用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
/*
 * 每次运行用独立临时目录：CI/并行跑（run-all 与手动、selftest 与全量）时
 * 若共用一个目录，后结束的一方的清理会删掉对方正在用的文件。
 */
const TMP = path.join(__dirname, '.tmp', 'selfcheck', 'run-' + process.pid + '-' + Date.now().toString(36));
const DEFAULT_SHIM = path.join(ROOT, 'extension', 'inject', 'tz-shim.js');
const SRC_SHIM = path.join(ROOT, 'src', 'tz-shim.js');
const ZONES_DIR = path.join(ROOT, 'extension', 'inject', 'zones');

const ARGV = process.argv.slice(2);
const QUICK = ARGV.indexOf('--quick') >= 0;
const ALL_ZONES = ARGV.indexOf('--all-zones') >= 0;
/*
 * --selftest：用一个「什么都不做的」替身脚本占据 shim 的位置，但让子进程 TZ 就等于目标时区。
 * 此时 native 组与 shim 组本质上是同一环境，若差分引擎无误，必须 0 mismatch。
 * 这是对本测试自身的假阳性检验（guard 用例不适用，会跳过）。
 */
const SELFTEST = ARGV.indexOf('--selftest') >= 0;
const KEEP = process.env.DSH_KEEP === '1';
const ZONE_ARGS = [];
for (let i = 0; i < ARGV.length; i += 1) {
  if (ARGV[i] === '--zone' && ARGV[i + 1]) ZONE_ARGS.push(ARGV[i + 1]);
}

function pickNode() {
  const cands = [process.env.DSH_NODE, process.execPath];
  for (const c of cands) {
    if (c && fs.existsSync(c) && /node(\.exe)?$/i.test(path.basename(c))) return c;
  }
  return null;
}
const NODE = pickNode();

function slugOf(zone) {
  return String(zone).replace(/\//g, '_').toLowerCase();
}

const SHIM_ARG = (function () {
  const i = ARGV.indexOf('--shim');
  return i >= 0 ? ARGV[i + 1] : null;
})();
/*
 * 默认测 src/tz-shim.js（源文件即真身）；extension/inject/tz-shim.js 是构建产物。
 * 若显式给了 --shim / DSH_SHIM_PATH，就用那个。
 */
const SHIM = (function () {
  const list = [SHIM_ARG, process.env.DSH_SHIM_PATH, SRC_SHIM, DEFAULT_SHIM];
  for (const c of list) if (c && fs.existsSync(c)) return c;
  return SRC_SHIM;
})();
function writeSelftestStub() {
  const p = path.join(TMP, 'selftest-stub.js');
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(p,
    '/* --selftest 替身：不做任何伪装，只写 marker */\n' +
    '(function () {\n' +
    '  var z = globalThis.__DSH_TZ_FIX_ZONE__;\n' +
    '  if (typeof z !== "string" || !z) return;\n' +
    '  globalThis.__DSH_TZ_FIX__ = { version: "1.0.0", zone: z, installedAt: Date.now() };\n' +
    '})();\n', 'utf8');
  return p;
}

function stalenessNote() {
  try {
    if (!fs.existsSync(SRC_SHIM) || !fs.existsSync(DEFAULT_SHIM)) return null;
    const a = fs.readFileSync(SRC_SHIM);
    const b = fs.readFileSync(DEFAULT_SHIM);
    if (a.equals(b)) return null;
    /* 构建产物通常只多一段头注释，做一次宽松比较 */
    if (b.toString('utf8').indexOf(a.toString('utf8').trim()) >= 0) return null;
    return '⚠ 构建产物 extension/inject/tz-shim.js 与 src/tz-shim.js 不一致（跑 node tools/build.cjs 重新生成）';
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------ *
 * 探针：在子进程里运行（必须自包含，不引用父进程作用域）
 * ------------------------------------------------------------------ */
function __tzProbeMain__() {
  'use strict';
  const vm = require('vm');
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync(process.env.DSH_PROBE_CFG, 'utf8'));
  const LIGHT = cfg.light === true; // 冒烟模式：跳过重矩阵

  /* 原生引用（安装前抓一次，只用于「原型未被替换 / 实例仍是原生 Date」结构断言） */
  const NativeDate = Date;
  const __RDP__ = Date.prototype;
  const __DFP__ = Intl.DateTimeFormat.prototype;
  /*
   * 行为探针必须走「当前全局」：shim 会替换 globalThis.Date 与 Intl.DateTimeFormat，
   * 若在这里提前捕获就会绕过伪装，制造虚假差异。安装与重复安装之后刷新。
   */
  let D = globalThis.Date;
  let DTF = globalThis.Intl.DateTimeFormat;
  function syncGlobals() {
    D = globalThis.Date;
    DTF = globalThis.Intl.DateTimeFormat;
  }

  const warnings = [];
  const realWarn = console.warn;
  console.warn = function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i += 1) parts.push(String(arguments[i]));
    warnings.push(parts.join(' '));
  };

  const install = { mode: cfg.mode, ran: false, threw: null, srcBytes: 0 };
  let shimSrc = null;
  if (cfg.shimPath) {
    try {
      shimSrc = fs.readFileSync(cfg.shimPath, 'utf8');
      install.srcBytes = shimSrc.length;
    } catch (e) {
      install.readError = String(e && e.message);
    }
  }

  function runShim(zoneValue) {
    if (zoneValue === undefined) delete globalThis.__DSH_TZ_FIX_ZONE__;
    else globalThis.__DSH_TZ_FIX_ZONE__ = zoneValue;
    vm.runInThisContext(shimSrc, { filename: 'tz-shim.js' });
  }

  if (cfg.mode === 'shim') {
    install.ran = true;
    try { runShim(cfg.zone); } catch (e) {
      install.threw = ((e && e.name) || 'Error') + ': ' + ((e && e.message) || String(e));
    }
  }

  syncGlobals();

  const marker = (function () {
    const m = globalThis.__DSH_TZ_FIX__;
    if (!m || typeof m !== 'object') return { present: false };
    return {
      present: true,
      version: typeof m.version === 'string' ? m.version : null,
      versionType: typeof m.version,
      zone: typeof m.zone === 'string' ? m.zone : null,
      zoneType: typeof m.zone,
      installedAtType: typeof m.installedAt,
      installedAtFinite: typeof m.installedAt === 'number' && isFinite(m.installedAt)
    };
  })();

  /* 幂等 / 重复注入 */
  let replay = null;
  if (cfg.reinstall) {
    const before = new D(0).toString();
    const markerBefore = globalThis.__DSH_TZ_FIX__;
    let threw = null;
    try { runShim(cfg.zone2 === undefined ? cfg.zone : cfg.zone2); } catch (e) { threw = (e && e.name) || 'Error'; }
    replay = {
      threw: threw,
      markerSameObject: globalThis.__DSH_TZ_FIX__ === markerBefore,
      behaviorUnchanged: before === new D(0).toString(),
      zoneAfter: (globalThis.__DSH_TZ_FIX__ && typeof globalThis.__DSH_TZ_FIX__.zone === 'string') ? globalThis.__DSH_TZ_FIX__.zone : null
    };
  }

  syncGlobals();

  console.warn = realWarn;

  /* ------------------------------------------------------------ 采集工具 */
  const R = {};       // 硬对拍
  const soft = {};    // 指纹类（仅报告）

  function norm(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') {
      if (v !== v) return 'NaN';
      if (v === Infinity) return 'Infinity';
      if (v === -Infinity) return '-Infinity';
      if (v === 0 && 1 / v === -Infinity) return '-0';
      return v;
    }
    if (Array.isArray(v)) return v.map(norm);
    return 'OBJ:' + t;
  }
  function cap(key, fn) {
    try { R[key] = norm(fn()); } catch (e) { R[key] = 'ERR:' + ((e && e.name) || 'Error'); }
  }
  function sput(key, fn) {
    try { soft[key] = norm(fn()); } catch (e) { soft[key] = 'ERR:' + ((e && e.name) || 'Error'); }
  }

  /* 生成「去掉末尾括号时区名」的字符串，用于把历史时区名差异与真实差异分开 */
  function stripName(s) {
    return typeof s === 'string' ? s.replace(/\([^()]*\)\s*$/, '()') : s;
  }

  const SAMPLES = [];
  const SAMPLE = {};
  function S(name, ts) { SAMPLES.push([name, ts]); SAMPLE[name] = ts; }

  S('epoch', 0);
  S('ms1', 1);
  S('ms-1', -1);
  S('big2009', 1234567890123);
  S('win2026', D.UTC(2026, 0, 15, 12, 0, 0));
  S('sum2026', D.UTC(2026, 6, 15, 12, 0, 0));
  S('ny2026', D.UTC(2025, 11, 31, 23, 59, 59, 999));
  S('dstSpringGap', D.UTC(2026, 2, 8, 10, 0, 0));
  S('dstSpringBefore', D.UTC(2026, 2, 8, 9, 59, 59, 999));
  S('dstSpringAfter1ms', D.UTC(2026, 2, 8, 10, 0, 0, 1));
  S('dstFallOverlap', D.UTC(2026, 10, 1, 8, 30, 0));
  S('dstFallAt', D.UTC(2026, 10, 1, 9, 0, 0));
  S('dstFallBefore', D.UTC(2026, 10, 1, 8, 59, 59, 999));
  S('y2038', D.UTC(2038, 0, 19, 3, 14, 7));
  S('y2100', D.UTC(2100, 6, 1, 12, 0, 0));
  S('y1900', D.UTC(1900, 0, 1));
  S('y1874', -3000000000000);
  S('y1811', -5000000000000);
  S('min', -8640000000000000);
  S('max', 8640000000000000);
  S('maxMinus1', 8639999999999999);
  S('minPlus1', -8639999999999999);
  S('nan', NaN);
  S('year0', D.parse('0000-06-15T12:00:00Z'));
  S('yearNeg1', D.parse('-000001-06-15T12:00:00Z'));

  /* ============================================================ 1. 采样矩阵 */
  const GETTERS = [
    'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
    'getMilliseconds', 'getYear', 'getTimezoneOffset',
    'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay', 'getUTCHours',
    'getUTCMinutes', 'getUTCSeconds', 'getUTCMilliseconds', 'getTime', 'valueOf'
  ];
  const TO_STR = ['toString', 'toDateString', 'toTimeString', 'toISOString', 'toUTCString', 'toJSON'];

  for (const [name, ts] of SAMPLES) {
    for (const m of GETTERS) cap('ts|' + name + '|' + m, () => new D(ts)[m]());
    for (const m of TO_STR) cap('ts|' + name + '|' + m, () => new D(ts)[m]());
    /* 时区显示名单独比：历史年份 V8 与 ICU 的口径不同，单独归类 */
    cap('ts|' + name + '|toStringNoName', () => stripName(new D(ts).toString()));
    cap('ts|' + name + '|toTimeStringNoName', () => stripName(new D(ts).toTimeString()));
    cap('ts|' + name + '|String', () => String(new D(ts)));
    cap('ts|' + name + '|plus', () => +new D(ts));
    cap('ts|' + name + '|concat', () => new D(ts) + '');
    cap('ts|' + name + '|template', () => '' + new D(ts));
    cap('ts|' + name + '|json', () => JSON.stringify(new D(ts)));
    cap('ts|' + name + '|jsonNested', () => JSON.stringify({ a: [new D(ts)] }));
    cap('ts|' + name + '|objTag', () => Object.prototype.toString.call(new D(ts)));
    cap('ts|' + name + '|toLocaleString()', () => new D(ts).toLocaleString());
    cap('ts|' + name + '|toLocaleDateString()', () => new D(ts).toLocaleDateString());
    cap('ts|' + name + '|toLocaleTimeString()', () => new D(ts).toLocaleTimeString());
  }

  /* 实例复用 / 缓存边界：同一实例反复读取 + 链式 set 跨 DST */
  cap('cache|sameInstanceGetters', () => {
    const d = new D(D.UTC(2026, 2, 8, 9, 30, 0));
    const out = [];
    for (let i = 0; i < 50; i += 1) out.push(d.getHours() + ':' + d.getTimezoneOffset() + ':' + d.toString());
    return out.length + '|' + out[0] + '|' + out[49];
  });
  cap('cache|eviction', () => {
    /* 打爆 ts->wall 缓存（8192）后仍须正确 */
    let acc = 0;
    const n = LIGHT ? 500 : 9000;
    for (let i = 0; i < n; i += 1) acc += new D(1200000000000 + i * 604800000).getHours();
    const probe = new D(D.UTC(2026, 0, 15, 12));
    return [acc, probe.getHours(), probe.toString(), probe.getTimezoneOffset()];
  });
  cap('cache|dtfEviction', () => {
    /* 打爆 formatter 缓存（256）后仍须正确 */
    const out = [];
    const locales = ['en-US', 'de-DE', 'ja-JP', 'fr-FR', 'zh-CN', 'en-GB', 'es-ES', 'it-IT'];
    for (let i = 0; i < 300; i += 1) {
      const d = new D(D.UTC(2026, 0, 15, 12));
      out.push(d.toLocaleString(locales[i % locales.length], { timeZoneName: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }
    return [out.length, out[0], out[299], new D(0).toLocaleString('en-US')];
  });
  cap('cache|chainSetAcrossDST', () => {
    const d = new D(D.UTC(2026, 2, 7, 12, 0, 0));
    const out = [];
    for (let i = 0; i < 8; i += 1) {
      d.setDate(d.getDate() + 1);
      out.push(d.toISOString() + '/' + d.getHours() + '/' + d.getTimezoneOffset());
    }
    return out;
  });
  cap('cache|chainSetMonthEnd', () => {
    const d = new D(D.UTC(2026, 0, 31, 12, 0, 0));
    const out = [];
    for (let i = 0; i < 14; i += 1) {
      d.setMonth(d.getMonth() + 1);
      out.push(d.toISOString() + '/' + d.getDate() + '/' + d.getHours());
    }
    return out;
  });

  /* ============================================================ 2. DST 扫描 */
  function sweep(label, start, count, stepMs) {
    for (let i = 0; i < count; i += 1) {
      const ts = start + i * stepMs;
      const d = new D(ts);
      R['sweep|' + label + '|' + i] = norm([ts, d.getTimezoneOffset(), d.getHours(), d.getMinutes(), d.getDate(), d.getMonth(), d.getDay()]);
    }
  }
  if (!LIGHT) {
  sweep('mar', D.UTC(2026, 2, 7, 0, 0, 0), 72, 3600000);
  sweep('nov', D.UTC(2026, 10, 1, 0, 0, 0), 72, 3600000);
  sweep('apr', D.UTC(2026, 3, 4, 0, 0, 0), 72, 3600000);
  sweep('oct', D.UTC(2026, 9, 2, 0, 0, 0), 72, 3600000);
  sweep('sep', D.UTC(2026, 8, 26, 0, 0, 0), 48, 3600000);
  sweep('decade', D.UTC(1970, 0, 1, 0, 0, 0), 12, 3153600000);
  }

  /* ============================================================ 3. toLocale* */
  const LOCALES = ['en-US', 'zh-CN', 'de-DE', 'ja-JP'];
  const OPTIONS = [
    ['none', null],
    ['empty', {}],
    ['dateStyleFull', { dateStyle: 'full' }],
    ['timeStyleShort', { timeStyle: 'short' }],
    ['bothStyles', { dateStyle: 'long', timeStyle: 'medium' }],
    ['tzLong', { timeZoneName: 'long' }],
    ['tzShort', { timeZoneName: 'short' }],
    ['tzLongOffset', { timeZoneName: 'longOffset' }],
    ['tzShortGeneric', { timeZoneName: 'shortGeneric' }],
    ['hour12false', { hour12: false }],
    ['hourCycleH23', { hourCycle: 'h23' }],
    ['explicitUTC', { timeZone: 'UTC' }],
    ['explicitTokyo', { timeZone: 'Asia/Tokyo' }],
    ['explicitUTCdateStyle', { timeZone: 'UTC', dateStyle: 'full' }],
    ['fullParts', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }],
    ['weekdayEra', { weekday: 'long', era: 'short', year: 'numeric' }],
    ['hourOnly', { hour: '2-digit' }],
    ['yearOnly', { year: 'numeric' }],
    ['dayOnly', { day: 'numeric' }],
    ['monthLong', { month: 'long' }],
    ['timeStyleFull', { timeStyle: 'full' }],
    ['fractional', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }]
  ];
  const LOC_TS = ['epoch', 'win2026', 'sum2026', 'dstFallOverlap', 'y2038', 'min'];

  if (!LIGHT) {
  for (const tsName of LOC_TS) {
    for (const [optName, opt] of OPTIONS) {
      for (const loc of LOCALES) {
        for (const meth of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
          cap('loc|' + tsName + '|' + loc + '|' + optName + '|' + meth, () => {
            const d = new D(SAMPLE[tsName]);
            return opt === null ? d[meth](loc) : d[meth](loc, opt);
          });
        }
      }
    }
  }

  }

  /* 用户 options 对象不得被改写 */
  for (const meth of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    cap('locOpt|mutate|' + meth, () => {
      const o = {};
      new D(0)[meth]('en-US', o);
      return JSON.stringify(o) + '|' + String(o.timeZone);
    });
  }
  cap('locOpt|mutateWithStyle', () => {
    const o = { timeStyle: 'short' };
    new D(0).toLocaleString('en-US', o);
    return JSON.stringify(o) + '|' + String(o.timeZone);
  });
  cap('locOpt|mutateDtf', () => {
    const o = { year: 'numeric' };
    new DTF('en-US', o);
    return JSON.stringify(o) + '|' + String(o.timeZone);
  });
  cap('locOpt|frozenOptions', () => {
    const o = Object.freeze({ year: 'numeric', month: 'long' });
    return new D(0).toLocaleString('en-US', o);
  });
  cap('locOpt|primitiveString', () => new D(0).toLocaleString('en-US', 'x'));
  cap('locOpt|null', () => new D(0).toLocaleString('en-US', null));
  cap('locOpt|undefined', () => new D(0).toLocaleString('en-US', undefined));
  cap('locOpt|getterThrows', () => {
    const o = { get year() { throw new RangeError('boom'); } };
    return new D(0).toLocaleString('en-US', o);
  });
  cap('locOpt|inheritedProps', () => {
    const proto = { month: 'long' };
    const o = Object.create(proto);
    return new D(0).toLocaleString('en-US', o);
  });

  /* ============================================================ 4. Date.parse */
  const PARSE_STRS = [
    '2026-01-15T00:00:00Z', '2026-01-15T00:00:00.000Z', '2026-01-15T00:00:00+08:00',
    '2026-01-15T00:00:00-0800', '2026-01-15T00:00:00', '2026-01-15T00:00:00.123',
    '2026-01-15T00:00:00.1234', '2026-01-15T00:00:00.123456789', '2026-01-15T00:00',
    '2026-01-15T00:00Z', '2026-01-15 00:00:00', '2026-01-15 00:00', '2026-01-15',
    '2026-01', '2026', '2026-02-30', '2026-02-30T00:00:00', '2026-13-01T00:00:00',
    '2026-01-32T00:00:00', '2026-01-15T25:00:00', '2026/01/15 08:30:00', '2026/01/15',
    '01/15/2026', 'Jan 15 2026 08:30', 'Jan 15, 2026', '15 Jan 2026', '15-Jan-2026',
    'Thu Jan 15 2026 08:30:00 GMT+0800', 'Thu Jan 15 2026 08:30:00 GMT+0800 (China Standard Time)',
    'Wed Dec 31 1969 16:00:00 GMT-0800 (Pacific Standard Time)', 'Thu Jan 15 2026',
    'Thu Jan 15 2026 08:30', '1970-01-01T00:00:00.000Z', '0000-01-01T00:00:00Z',
    '+010000-01-01T00:00:00Z', '-000001-06-15T12:00:00Z', '2026-01-15t00:00:00z',
    '2026-01-15T00:00:00 z', 'abc', '', '   ', ' 2026-01-15T00:00:00 ', '08:30',
    '275760-09-13T00:00:00Z', '-271821-04-20T00:00:00Z', 'Infinity', 'null',
    '2026-01-15T00:00:00+08', '2026-01-15T00:00:00GMT', '2026-01-15T00:00:00UTC'
  ];
  if (!LIGHT) {
  for (const s of PARSE_STRS) {
    cap('parse|' + s, () => D.parse(s));
    cap('ctorStr|' + s, () => new D(s).getTime());
  }
  }
  cap('parse|nonString', () => D.parse(new D(0)));
  cap('parse|undefined', () => D.parse(undefined));
  cap('parse|null', () => D.parse(null));
  cap('parse|number', () => D.parse(1234567890123));
  cap('parse|symbol', () => D.parse(Symbol('x')));
  cap('parse|toStringRoundtrip', () => D.parse(new D(D.UTC(2026, 0, 15, 12)).toString()));
  cap('parse|toUTCStringRoundtrip', () => D.parse(new D(D.UTC(2026, 0, 15, 12)).toUTCString()));
  cap('parse|toDateStringRoundtrip', () => D.parse(new D(D.UTC(2026, 0, 15, 12)).toDateString()));
  cap('parse|toISOStringRoundtrip', () => D.parse(new D(D.UTC(2026, 0, 15, 12)).toISOString()));
  cap('parse|legacyRoundtrip', () => {
    const d = new D(D.UTC(2026, 0, 15, 12));
    return [D.parse(d.toLocaleString('en-US')), D.parse('Jan 15 2026 08:30'), D.parse('2026/01/15 08:30:00')];
  });

  /* ============================================================ 5. 构造函数 */
  const CTOR_ARGS = [
    [1234567890123], [0], [-1], [NaN], [Infinity], [-Infinity], ['1234567890123'],
    [null], [true], [false], [''], ['  '], ['0'], ['2026-01-15T00:00:00.123456789Z'],
    [2026, 0, 15], [2026, 0], [2026], [99, 0, 1], [0, 0, 1], [100, 0, 1], [-1, 0, 1],
    [2026.9, 0, 1], [2026, 13, 1], [2026, -1, 1], [2026, 0, 32], [2026, 0, 0], [2026, 0, -1],
    [2026, 2, 8, 1, 59, 59, 999], [2026, 2, 8, 2, 0], [2026, 2, 8, 2, 30], [2026, 2, 8, 3, 0],
    [2026, 10, 1, 0, 30], [2026, 10, 1, 1, 0], [2026, 10, 1, 1, 30], [2026, 10, 1, 2, 0],
    [2026, 0, 1, 1.5, 2.5, 3.5, 4.5], [2026, 0, 1, -1.5, -0.5],
    [NaN, 0, 1], [2026, 0, 1, NaN], [2026, NaN, 1], [Infinity, 0, 1],
    [275760, 8, 12], [275760, 8, 13], [-271821, 3, 20], [-271821, 3, 19],
    [2026, 0, 1, 0, 0, 0, 0], [2026, 0, 1, 0, 0, 0, 999.9], [2026, 0, 1, 2, 3, 4, 5, 6],
    ['2026', '0', '15'], [2026, 0, '15'], [2026, 0, 15, '2'], [null, 0, 1]
  ];
  const safeISO = (d) => { try { return d.toISOString(); } catch (e) { return 'ERR:' + ((e && e.name) || 'Error'); } };
  const safeStr = (d) => { try { return d.toString(); } catch (e) { return 'ERR:' + ((e && e.name) || 'Error'); } };

  if (!LIGHT) {
  for (const args of CTOR_ARGS) {
    const label = JSON.stringify(args);
    cap('ctor|' + label, () => {
      const d = Reflect.construct(D, args);
      return [d.getTime(), safeISO(d), safeStr(d), d.getTimezoneOffset()];
    });
  }
  }
  cap('ctor|noArgsInstanceof', () => { const d = new D(); return [d instanceof D, typeof d.getTime()]; });
  cap('ctor|copyDate', () => { const d = new D(1234567890123); return [new D(d).getTime(), new D(d).toISOString()]; });
  cap('ctor|valueOf', () => new D({ valueOf() { return 5; } }).getTime());
  cap('ctor|toStringObj', () => new D({ toString() { return '2026-01-15T00:00:00Z'; } }).getTime());
  cap('ctor|symbol', () => new D(Symbol('x')));
  cap('ctor|bigint', () => new D(BigInt(5)));
  cap('ctor|array', () => new D([2026, 0, 1]).getTime());
  cap('ctor|proxy', () => {
    const p = new Proxy({ valueOf() { return 7; } }, {});
    return new D(p).getTime();
  });
  cap('ctor|protoDate', () => { const d = Object.create(D.prototype); return [new D(d).getTime(), d.getTime()]; });

  /* Date() 无 new */
  cap('fn|DateCallTypeof', () => typeof D());
  cap('fn|DateCallSuffix', () => { const m = /(GMT[+-]\d{4} \([^)]*\))\s*$/.exec(D()); return m ? m[1] : 'NO-MATCH'; });
  cap('fn|DateCallShape', () => /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} -?\d{4,6} \d{2}:\d{2}:\d{2} GMT[+-]\d{4} \(.+\)$/.test(D()));
  /*
   * 注意：D.call(...) / D.apply(...) 返回的是「当前时刻」的字符串，
   * 两个子进程之间必然相差若干毫秒，无法跨进程比对；这里只保留
   * 与时刻无关的形态断言（DateCallShape / DateCallSuffix），
   * 并把「不是 undefined」的调用语义放在 soft 里记录。
   */
  sput('fn|DateCallViaCall', () => typeof D.call({}, 0));

  /* ============================================================ 6. set* */
  const SET_BASES = [
    ['utc2026', D.UTC(2026, 0, 15, 12, 0, 0)],
    ['epoch', 0],
    ['spring', D.UTC(2026, 2, 8, 9, 30, 0)],
    ['fall', D.UTC(2026, 10, 1, 8, 30, 0)],
    ['nan', NaN],
    ['pre1970', D.UTC(1969, 11, 31, 23, 30, 0)],
    ['min', -8640000000000000],
    ['max', 8640000000000000]
  ];
  const SETTERS = [
    ['setFullYear', [2027]], ['setFullYear', [2027, 5]], ['setFullYear', [2027, 5, 15]],
    ['setFullYear', [0]], ['setFullYear', [NaN]], ['setFullYear', ['2027']], ['setFullYear', []],
    ['setMonth', [5]], ['setMonth', [-1]], ['setMonth', [13]], ['setMonth', [1.5]],
    ['setMonth', [11, 31]], ['setMonth', [NaN]], ['setMonth', []],
    ['setDate', [1]], ['setDate', [0]], ['setDate', [-1]], ['setDate', [32]],
    ['setDate', [NaN]], ['setDate', [1.9]], ['setDate', [null]], ['setDate', []],
    ['setHours', [0]], ['setHours', [2]], ['setHours', [2, 30]], ['setHours', [2, 30, 15]],
    ['setHours', [2.5]], ['setHours', [-1]], ['setHours', [24]], ['setHours', [2, 30, 15, 999]],
    ['setHours', [NaN]], ['setHours', ['9']], ['setHours', []],
    ['setMinutes', [0]], ['setMinutes', [59]], ['setMinutes', [-1]], ['setMinutes', [30, 0]],
    ['setMinutes', [0, 0, 0]], ['setMinutes', [NaN]], ['setMinutes', []],
    ['setSeconds', [0]], ['setSeconds', [59]], ['setSeconds', [-1]],
    ['setSeconds', [30, 0]], ['setSeconds', [NaN]], ['setSeconds', []],
    ['setMilliseconds', [0]], ['setMilliseconds', [999]], ['setMilliseconds', [1500]],
    ['setMilliseconds', [-1]], ['setMilliseconds', [1.9]], ['setMilliseconds', [NaN]], ['setMilliseconds', []],
    ['setYear', [99]], ['setYear', [100]], ['setYear', [0]], ['setYear', [-1]],
    ['setYear', [2027]], ['setYear', [NaN]], ['setYear', []],
    ['setTime', [0]], ['setTime', [NaN]], ['setTime', [1234567890123]]
  ];
  if (!LIGHT) {
  for (const [baseName, baseTs] of SET_BASES) {
    for (const [fnName, args] of SETTERS) {
      cap('set|' + baseName + '|' + fnName + '(' + JSON.stringify(args) + ')', () => {
        const d = new D(baseTs);
        const ret = d[fnName].apply(d, args);
        return [ret, d.getTime(), safeStr(d), d.getTimezoneOffset(), d.getHours(), d.getDate(), d.getMonth(), d.getFullYear()];
      });
    }
  }

  }

  /* ============================================================ 7. 类型校验 */
  const RECEIVERS = [
    ['plainObj', {}], ['null', null], ['undefined', undefined], ['number', 0],
    ['string', 'x'], ['array', []], ['dateProto', D.prototype], ['realDate', new D(0)],
    ['protoDerived', Object.create(D.prototype)], ['symbol', Symbol('x')]
  ];
  const RECV_METHODS = [
    'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
    'getMilliseconds', 'getYear', 'getTimezoneOffset', 'toString', 'toDateString', 'toTimeString',
    'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
    'setHours', 'setFullYear', 'setDate', 'setYear', 'setMilliseconds', 'setMonth', 'setSeconds', 'setMinutes'
  ];
  if (!LIGHT) {
  for (const [rcName, rc] of RECEIVERS) {
    for (const m of RECV_METHODS) {
      cap('recv|' + rcName + '|' + m, () => __RDP__[m].call(rc, 1));
    }
  }

  }

  /* ============================================================ 8. 子类 / 跨 realm */
  cap('class|basic', () => {
    class D extends D {}
    const d = new D(0);
    return [d.getTime(), d.getHours(), d.getTimezoneOffset(), d.toString(), d instanceof D, d instanceof D,
      Object.getPrototypeOf(d) === D.prototype, Object.prototype.toString.call(d)];
  });
  cap('class|superFields', () => { class D extends D { constructor() { super(2026, 2, 8, 2, 30); } } return new D().toISOString(); });
  cap('class|superString', () => { class D extends D {} return new D(new (class extends D {})('2026-01-15T00:00:00')).toISOString(); });
  cap('class|statics', () => { class D extends D {} return [typeof D.now, D.now === D.now, D.UTC === D.UTC, D.parse === D.parse, Object.getPrototypeOf(D) === D]; });
  cap('class|extraProps', () => { class D extends D { constructor(v) { super(v); this.tag = 'x'; } } const d = new D(0); return [d.tag, d.getFullYear(), JSON.stringify(d), String(d) === d.toString()]; });
  cap('class|noNewTarget', () => { class D extends D {} return Reflect.construct(D, [0], D).getHours(); });
  cap('class|subSub', () => { class A extends D {} class B extends A {} const b = new B(0); return [b instanceof A, b instanceof D, b.getHours()]; });
  cap('proto|constructorProp', () => [D.prototype.constructor === D, new D(0).constructor === D]);
  cap('id|DateProtoIdentity', () => D.prototype === __RDP__);
  cap('id|DTFProtoIdentity', () => Intl.DateTimeFormat.prototype === __DFP__);
  cap('id|instanceProto', () => Object.getPrototypeOf(new D(0)) === D.prototype);
  cap('id|stillNativeDate', () => new D(0) instanceof NativeDate);
  cap('id|realDateStillWorks', () => new NativeDate(1234567890123).toISOString());
  cap('id|dateValueOf', () => D.prototype.getTime.call(new D(0)));
  cap('proto|ownPropNames', () => Object.getOwnPropertyNames(D.prototype).sort());
  cap('proto|symbols', () => Object.getOwnPropertySymbols(D.prototype).map(String));
  cap('proto|descriptor_hours', () => { const d = Object.getOwnPropertyDescriptor(D.prototype, 'getHours'); return [typeof d.value, d.writable, d.enumerable, d.configurable]; });
  cap('proto|definePropertyFrozen', () => {
    try {
      Object.defineProperty(D.prototype, '__probe__', { value: 1, configurable: true });
      const ok = D.prototype.__probe__ === 1;
      delete D.prototype.__probe__;
      return ok;
    } catch (e) { return 'ERR:' + ((e && e.name) || 'Error'); }
  });
  sput('realm|vmContext', () => {
    const ctx = vm.createContext({});
    return vm.runInContext('typeof Date + "|" + new Date(0).toString()', ctx);
  });

  /* ============================================================ 9. Intl */
  cap('intl|defaultTz', () => new DTF().resolvedOptions().timeZone);
  cap('intl|defaultRo', () => { const ro = new DTF().resolvedOptions(); return [ro.locale, ro.timeZone, ro.year, ro.month, ro.day, ro.hour, ro.minute, ro.second]; });
  cap('intl|defaultFormat', () => new DTF().format(0));
  cap('intl|formatSamples', () => SAMPLES.slice(0, 12).map(([, ts]) => new DTF().format(ts)));
  cap('intl|explicitUTC', () => { const f = new DTF('en-US', { timeZone: 'UTC' }); return [f.resolvedOptions().timeZone, f.format(0), f.formatToParts(0).map((p) => p.type + '=' + p.value)]; });
  cap('intl|explicitTokyoLong', () => new DTF('en-US', { timeZone: 'Asia/Tokyo', timeZoneName: 'long' }).format(D.UTC(2026, 0, 15, 12)));
  cap('intl|tzUndefined', () => new DTF('en-US', { timeZone: undefined }).resolvedOptions().timeZone);
  cap('intl|invalidTz', () => new DTF('en-US', { timeZone: 'Nope/Nope' }).resolvedOptions().timeZone);
  cap('intl|nullOptions', () => new DTF('en-US', null).format(0));
  cap('intl|primitiveOptions', () => new DTF('en-US', 'en').format(0));
  cap('intl|optsMutation', () => { const o = { year: 'numeric' }; const f = new DTF('en-US', o); return [JSON.stringify(o), String(o.timeZone), f.resolvedOptions().timeZone, f.format(0)]; });
  cap('intl|callNoNew', () => [DTF('en-US') instanceof DTF, DTF('en-US').resolvedOptions().timeZone]);
  cap('intl|subclass', () => { class M extends DTF {} const m = new M('en-US'); return [m.resolvedOptions().timeZone, m.format(0), Object.getPrototypeOf(m) === M.prototype, m instanceof M, m instanceof DTF]; });
  cap('intl|protoIdentity', () => [Intl.DateTimeFormat.prototype === __DFP__, typeof Intl.DateTimeFormat.prototype.format, Object.getOwnPropertyNames(__DFP__).sort()]);
  cap('intl|formatToPartsFull', () => new DTF('en-US', { timeZoneName: 'long', dateStyle: 'full', timeStyle: 'long' }).formatToParts(D.UTC(2026, 0, 15, 12)).map((p) => [p.type, p.value]));
  cap('intl|formatRange', () => [new DTF('en-US', { timeZone: 'UTC' }).formatRange(0, 86400000), new DTF('en-US').formatRange(new D(0), new D(86400000))]);
  cap('intl|formatRangeToParts', () => new DTF('en-US').formatRangeToParts(0, 86400000).map((p) => [p.type, p.value, p.source]));
  cap('intl|formatBound', () => { const f = new DTF('en-US', { timeZone: 'UTC' }).format; return [f(0), f(new D(0)), f('2026-01-15T00:00:00Z')]; });
  cap('intl|formatCoerce', () => { const f = new DTF('en-US', { timeZone: 'UTC' }); return [f(0.9), f(1.7), f(null), f(true), f(1e3)]; });
  cap('intl|formatInvalid', () => new DTF('en-US', { timeZone: 'UTC' }).format(NaN));
  cap('intl|formatOutOfRange', () => new DTF('en-US', { timeZone: 'UTC' }).format(8640000000000001));
  cap('intl|supportedLocalesOf', () => Intl.DateTimeFormat.supportedLocalesOf(['en-US', 'xx-XX', 'zh-CN']));
  cap('intl|hourCycleDefault', () => new DTF('en-US').resolvedOptions().hourCycle);
  cap('intl|dayPeriod', () => new DTF('en-US', { hour: 'numeric', hourCycle: 'h12' }).format(D.UTC(2026, 0, 15, 0)));
  cap('intl|dateObjectFormat', () => new DTF('en-US', { timeZone: 'UTC' }).format(new D(0)));
  cap('intl|formatOnShimmedDate', () => { const d = new D(D.UTC(2026, 2, 8, 10, 0, 0)); return [new DTF('en-US').format(d), d.toLocaleString('en-US')]; });

  /* ============================================================ 10. 指纹（soft） */
  for (const [name, fn] of [
    ['Date', () => Date], ['getHours', () => D.prototype.getHours], ['toString', () => D.prototype.toString],
    ['toLocaleString', () => D.prototype.toLocaleString], ['parse', () => D.parse], ['UTC', () => D.UTC],
    ['DTF', () => Intl.DateTimeFormat]
  ]) {
    sput('src|' + name, () => Function.prototype.toString.call(fn()).slice(0, 120));
  }
  sput('meta|Date', () => [D.length, D.name, String(D), Object.getPrototypeOf(D) === Function.prototype]);
  sput('meta|ownNamesDate', () => Object.getOwnPropertyNames(D).sort());
  sput('meta|dtfProtoOwnNames', () => Object.getOwnPropertyNames(Intl.DateTimeFormat.prototype).sort());
  sput('meta|globals', () => Object.getOwnPropertyNames(globalThis).filter((n) => n.indexOf('DSH') >= 0 || n.indexOf('TZ') >= 0 || n.indexOf('tz') >= 0).sort());

  /* ============================================================ 11. 性能 */
  const perf = {};
  if (cfg.perf) {
    const N = 100000;
    const base = D.UTC(2026, 0, 15, 12, 0, 0);
    let acc = 0;
    let t = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) acc += new D(base + i * 1800000).getHours();
    perf.getHours100kMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) acc += new D(base + i * 1800000).getTimezoneOffset();
    perf.getTimezoneOffset100kMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    for (let i = 0; i < 20000; i += 1) acc += new D(base + i * 1800000).toString().length;
    perf.toString20kMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    for (let i = 0; i < 20000; i += 1) acc += new D(2026, 0, 1, i % 24, 0, 0).getTime();
    perf.ctor20kMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    for (let i = 0; i < 20000; i += 1) acc += new D(base + i * 1800000).toLocaleString().length;
    perf.toLocale20kMs = Number(process.hrtime.bigint() - t) / 1e6;

    perf.acc = acc;
  }

  fs.writeFileSync(cfg.outPath, JSON.stringify({
    meta: {
      mode: cfg.mode,
      zone: cfg.zone === undefined ? null : cfg.zone,
      node: process.version,
      resolvedTz: (function () { try { return new DTF().resolvedOptions().timeZone; } catch (e) { return 'ERR'; } })()
    },
    install: install,
    marker: marker,
    replay: replay,
    warnCount: warnings.length,
    warnings: warnings.slice(0, 4),
    R: R,
    soft: soft,
    perf: perf
  }));
}


/* ------------------------------------------------------------------ *
 * 父进程：驱动子进程 + 比对
 * ------------------------------------------------------------------ */

const realWrite = process.stdout.write.bind(process.stdout);
const results = [];
const softTotals = { count: 0, samples: [] };
let hardFail = 0;

function fail(name, lines) {
  results.push({ name: name, ok: false, lines: lines || [] });
  hardFail += 1;
}
function pass(name) {
  results.push({ name: name, ok: true, lines: [] });
}

function norm(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') {
    if (v !== v) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (v === 0 && 1 / v === -Infinity) return '-0';
    return v;
  }
  if (Array.isArray(v)) return v.map(norm);
  return 'OBJ:' + t;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  return false;
}
function collectDiffs(expected, actual) {
  const out = [];
  const keys = new Set(Object.keys(expected || {}).concat(Object.keys(actual || {})));
  for (const k of keys) {
    const a = expected ? expected[k] : undefined;
    const b = actual ? actual[k] : undefined;
    if (!deepEqual(a, b)) out.push({ key: k, expected: a, actual: b });
  }
  return out;
}
function fmt(v) {
  let s;
  try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  if (s === undefined) s = 'undefined';
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

/*
 * 分类：只有末尾括号里的「时区显示名」不同 —— 不计为硬差异。
 *
 * 原因：V8 的 Date.prototype.toString 走 DateCache（能给出 historic/metazone 标准名，
 * 例如 1874 年的 "北美太平洋标准时间"），而 Intl.DateTimeFormat 的 timeZoneName
 * 在 ICU 认为没有本地化名字时会退化成 "GMT-07:52:58"。两者都是平台原生的，
 * 但 shim 只能从 ICU 取名字，这个差异在 1970 年前与 ±上限年份必然出现。
 */
/* 依赖「当前时刻」的探针，两个子进程必然不同，直接跳过 */
const NONDETERMINISTIC = /^(fn\|DateCallCall|fn\|DateCallApply)$/;
function isNondeterministic(key) {
  return NONDETERMINISTIC.test(key);
}

function nameOnlyDiff(key, expected, actual) {
  const strip = (v) => JSON.stringify(v).replace(/\((?:[^()]*)\)/g, '()');
  return strip(expected) === strip(actual);
}

let seq = 0;
const dirCache = new Map();

function runProbe(cfg, env) {
  seq += 1;
  const id = String(seq).padStart(3, '0');
  const cfgPath = path.join(TMP, 'cfg-' + id + '.json');
  const outPath = path.join(TMP, 'out-' + id + '.json');
  const logOut = path.join(TMP, 'log-' + id + '.out');
  const logErr = path.join(TMP, 'log-' + id + '.err');
  fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg, { outPath: outPath })), 'utf8');

  const childEnv = Object.assign({}, process.env, env, { DSH_PROBE_CFG: cfgPath });
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];

  const fdOut = fs.openSync(logOut, 'w');
  const fdErr = fs.openSync(logErr, 'w');
  let res;
  try {
    res = cp.spawnSync(NODE, [PROBE_FILE], { stdio: ['ignore', fdOut, fdErr], env: childEnv, timeout: 240000 });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
  const stdout = readSafe(logOut);
  const stderr = readSafe(logErr);
  if (res.error) return { ok: false, err: 'spawn 失败: ' + (res.error.code || res.error.message), stderr: stderr };
  if (res.status !== 0) return { ok: false, err: '退出码 ' + res.status + (res.signal ? ' / ' + res.signal : ''), stderr: stderr };
  const raw = readSafe(outPath);
  if (!raw) return { ok: false, err: '未写出结果 JSON', stderr: stderr, stdout: stdout };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, err: '结果 JSON 解析失败: ' + e.message, stderr: stderr };
  }
}

const nativeCache = new Map();
function nativeRun(zone, perf, smoke) {
  const key = zone + '|' + (perf ? 1 : 0) + '|' + (smoke ? 1 : 0);
  if (nativeCache.has(key)) return nativeCache.get(key);
  const r = runProbe({ mode: 'native', shimPath: null, perf: !!perf, light: !!smoke }, { TZ: zone });
  nativeCache.set(key, r);
  return r;
}
function shimRun(zone, hostTz, extra) {
  const shimPath = global.__SHIM_OVERRIDE__ || SHIM;
  return runProbe(Object.assign({ mode: 'shim', zone: zone, shimPath: shimPath }, extra || {}), { TZ: hostTz });
}

function canonicalZone(zone) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; } catch (e) { return null; }
}

/* 主对拍：native vs shim */
let QUIET = false;
function out(line) { if (!QUIET || /\[FAIL\]|^    [!-]/.test(line)) realWrite(line + '\n'); }

function compareZone(zone, hostTz, opts) {
  const perf = !!(opts && opts.perf);
  const smoke = !!(opts && opts.smoke);
  const title = zone + '  (host TZ=' + hostTz + ')' + (opts && opts.note ? ' [' + opts.note + ']' : '');
  const nres = nativeRun(zone, perf, smoke);
  const sres = shimRun(zone, hostTz, { perf: perf, light: smoke });

  if (!nres.ok || !sres.ok) {
    const bad = !nres.ok ? { who: 'native', r: nres } : { who: 'shim', r: sres };
    const tailLines = (bad.r.stderr || '').trim().split(/\r?\n/).slice(-6).map((l) => '      ' + l).join('\n');
    out('[FAIL] ' + title + '\n    子进程失败(' + bad.who + '): ' + bad.r.err + '\n' + (tailLines ? tailLines + '\n' : ''));
    fail(title, ['子进程失败: ' + bad.r.err]);
    return null;
  }

  const expected = nres.data.R;
  const actual = sres.data.R;
  const allDiffs = collectDiffs(expected, actual).filter((d) => !isNondeterministic(d.key));

  const hard = [];
  const nameOnly = [];
  for (const d of allDiffs) {
    if (nameOnlyDiff(d.key, d.expected, d.actual)) nameOnly.push(d);
    else hard.push(d);
  }

  /* 结构断言 */
  const struct = [];
  const SELFTEST_MODE = !!global.__SHIM_OVERRIDE__;
  const inst = sres.data.install || {};
  const marker = sres.data.marker || {};
  if (inst.threw) struct.push('安装抛错: ' + inst.threw);
  if (!SELFTEST_MODE && !marker.present) struct.push('未设置 globalThis.__DSH_TZ_FIX__');
  else if (!SELFTEST_MODE) {
    if (marker.versionType !== 'string') struct.push('__DSH_TZ_FIX__.version 不是字符串');
    if (marker.zoneType !== 'string') struct.push('__DSH_TZ_FIX__.zone 不是字符串');
    if (!marker.installedAtFinite) struct.push('__DSH_TZ_FIX__.installedAt 不是有限数字');
    const canon = canonicalZone(zone);
    if (marker.zone !== zone && marker.zone !== canon) {
      struct.push('__DSH_TZ_FIX__.zone=' + fmt(marker.zone) + '，期望 ' + zone + '（或规范名 ' + fmt(canon) + '）');
    }
  }

  /* soft 差异（指纹） */
  const softDiffs = collectDiffs(nres.data.soft, sres.data.soft);
  softTotals.count += softDiffs.length;
  for (const d of softDiffs) if (softTotals.samples.length < 6) softTotals.samples.push(zone + ' :: ' + d.key);

  const ok = hard.length === 0 && struct.length === 0;
  const tag = ok ? '[ OK ]' : '[FAIL]';
  out(tag + ' ' + title);
  out('       keys native=' + Object.keys(expected).length + ' shim=' + Object.keys(actual).length +
    '  mismatch=' + hard.length + '  nameOnly=' + nameOnly.length + '  soft=' + softDiffs.length);

  for (const s of struct) out('    ! ' + s);

  if (hard.length) {
    const shown = hard.slice(0, 12);
    for (const d of shown) {
      out('    - ' + d.key);
      out('        native = ' + fmt(d.expected));
      out('        shim   = ' + fmt(d.actual));
    }
    if (hard.length > shown.length) out('    ...（另有 ' + (hard.length - shown.length) + ' 条硬差异未显示）');
  }
  if (nameOnly.length) {
    const shownH = nameOnly.slice(0, 3);
    for (const d of shownH) {
      out('    ~ nameOnly ' + d.key + ': native=' + fmt(d.expected) + ' shim=' + fmt(d.actual));
    }
    if (nameOnly.length > shownH.length) out('    ~ ...（另有 ' + (nameOnly.length - shownH.length) + ' 条仅时区显示名不同）');
  }
  if (softDiffs.length) {
    for (const d of softDiffs.slice(0, 5)) {
      out('    ~ soft ' + d.key + ': native=' + fmt(d.expected) + ' shim=' + fmt(d.actual));
    }
  }

  if (perf && sres.data.perf) {
    const sp = sres.data.perf;
    const np = nres.data.perf || {};
    out('       perf shim: getHours x100k=' + sp.getHours100kMs.toFixed(1) + 'ms' +
      '  getTimezoneOffset x100k=' + sp.getTimezoneOffset100kMs.toFixed(1) + 'ms' +
      '  toString x20k=' + sp.toString20kMs.toFixed(1) + 'ms' +
      '  ctorFields x20k=' + sp.ctor20kMs.toFixed(1) + 'ms' +
      '  toLocaleString x20k=' + sp.toLocale20kMs.toFixed(1) + 'ms' +
      '  (native getHours=' + (np.getHours100kMs ? np.getHours100kMs.toFixed(1) : '?') + 'ms)');
    if (!(sp.getHours100kMs < 200)) {
      out('    ! 性能未达标：100k 次 getHours ' + sp.getHours100kMs.toFixed(1) + 'ms，要求 < 200ms');
      struct.push('性能未达标');
    }
    if (sp.acc === undefined) struct.push('perf.acc 缺失');
  }

  if (ok) pass(title); else fail(title, struct.concat(hard.map((d) => d.key + ' native=' + fmt(d.expected) + ' shim=' + fmt(d.actual))));
  return sres.data;
}

/* 守卫用例：不安装 / 幂等 */
function guardCase(name, zone, hostTz, expectInstalled, extraAssert) {
  /* 只有在「应当安装成功」的用例里才做重复注入：否则第二次会用合法 zone 真的装上，
     反而掩盖「非法 zone 必须安静退出」这个待验证行为。 */
  const sres = expectInstalled
    ? shimRun(zone, hostTz, { reinstall: true, zone2: 'Asia/Tokyo' })
    : shimRun(zone, hostTz, {});
  if (!sres.ok) {
    out('[FAIL] ' + name + '\n    子进程失败: ' + sres.err);
    fail(name, ['子进程失败']);
    return;
  }
  const issues = [];
  const inst = sres.data.install || {};
  const marker = sres.data.marker || {};
  if (inst.threw) issues.push('抛错: ' + inst.threw);
  if (expectInstalled) {
    if (!marker.present) issues.push('未安装（未设置 __DSH_TZ_FIX__）');
  } else {
    if (marker.present) issues.push('不应安装，但设置了 __DSH_TZ_FIX__');
    if (sres.data.replay && sres.data.replay.zoneAfter) issues.push('不应安装，但重复注入产生了 zone');
  }
  if (sres.data.replay) {
    const rp = sres.data.replay;
    if (rp.threw) issues.push('重复注入抛错: ' + rp.threw);
    if (!rp.behaviorUnchanged) issues.push('重复注入改变了 Date 行为');
    if (expectInstalled && !rp.markerSameObject) issues.push('重复注入替换了 __DSH_TZ_FIX__ 对象（应幂等返回）');
  }
  /* 未安装时行为必须等于宿主时区的真身 */
  if (!expectInstalled) {
    const nres = nativeRun(hostTz, false);
    const diffs = collectDiffs(nres.data.R, sres.data.R).filter((d) => !isNondeterministic(d.key));
    const hardDiffs = diffs.filter((d) => !nameOnlyDiff(d.key, d.expected, d.actual));
    if (hardDiffs.length) {
      issues.push('未安装时行为与宿主真身不一致: ' + hardDiffs.length + ' 条，首条 ' + hardDiffs[0].key + ' native=' + fmt(hardDiffs[0].expected) + ' shim=' + fmt(hardDiffs[0].actual));
    }
  }
  if (extraAssert) {
    const extra = extraAssert(sres.data);
    for (const e of extra) issues.push(e);
  }
  const ok = issues.length === 0;
  out((ok ? '[ OK ] ' : '[FAIL] ') + name);
  if (sres.data.warnCount) out('       warn(' + sres.data.warnCount + '): ' + fmt(sres.data.warnings));
  for (const i of issues) out('    ! ' + i);
  if (ok) pass(name); else fail(name, issues);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const TEST_ZONES = QUICK
  ? [
    { zone: 'America/Los_Angeles', hostTz: 'Asia/Shanghai', note: 'DST', perf: true },
    { zone: 'America/Los_Angeles', hostTz: 'UTC', note: 'UTC 宿主' },
    { zone: 'Asia/Calcutta', hostTz: 'Asia/Shanghai', note: '+5:30' }
  ]
  : [
    { zone: 'America/Los_Angeles', hostTz: 'Asia/Shanghai', note: 'DST 跳变/重叠', perf: true },
    { zone: 'America/Los_Angeles', hostTz: 'UTC', note: '同一目标/不同宿主' },
    { zone: 'America/New_York', hostTz: 'Asia/Shanghai' },
    { zone: 'America/St_Johns', hostTz: 'Asia/Shanghai', note: '-3:30 半时区' },
    { zone: 'Europe/London', hostTz: 'Asia/Shanghai', note: '负 UTC 偏移 DST' },
    { zone: 'Europe/Berlin', hostTz: 'Asia/Shanghai' },
    { zone: 'Europe/Dublin', hostTz: 'Asia/Shanghai', note: '负 DST 语义' },
    { zone: 'Asia/Tokyo', hostTz: 'Asia/Shanghai' },
    { zone: 'Asia/Shanghai', hostTz: 'America/New_York', note: '宿主与目标反向' },
    { zone: 'Asia/Calcutta', hostTz: 'Asia/Shanghai', note: '+5:30（ICU 规范名）' },
    { zone: 'Asia/Kolkata', hostTz: 'Asia/Shanghai', note: 'ICU 别名' },
    { zone: 'Pacific/Chatham', hostTz: 'Asia/Shanghai', note: '+12:45' },
    { zone: 'Australia/Sydney', hostTz: 'Asia/Shanghai' },
    { zone: 'Australia/Lord_Howe', hostTz: 'Asia/Shanghai', note: '30 分钟 DST' },
    { zone: 'UTC', hostTz: 'Asia/Shanghai' },
    { zone: 'Pacific/Kiritimati', hostTz: 'America/Los_Angeles', note: '+14 跨日界' }
  ];

function main() {
  if (!NODE) {
    process.stdout.write('[selfcheck] 环境错误：process.execPath 不是 node（' + process.execPath + '），请用 DSH_NODE 指定。\n');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(SHIM)) {
    process.stdout.write('[selfcheck] 找不到被测 shim：' + SHIM + '\n  先运行：node tools/build.cjs\n');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(TMP, { recursive: true });

  if (SELFTEST) {
    /* 替身脚本 + 子进程 TZ 直接等于目标时区 ⇒ 期望零差异 */
    global.__SHIM_OVERRIDE__ = writeSelftestStub();
  }

  /* 探针脚本落盘（本文件内自包含） */
  PROBE_FILE = path.join(TMP, 'probe.cjs');
  fs.writeFileSync(PROBE_FILE, "'use strict';\n(" + __tzProbeMain__.toString() + ")();\n", 'utf8');

  const started = Date.now();
  process.stdout.write('======================================================================\n');
  process.stdout.write(' DSH TZ Fix · 伪装脚本 vs 真身 差分对拍（期望值来自 TZ=<zone> 的原生 Node）\n');
  process.stdout.write('======================================================================\n');
  process.stdout.write(' node  : ' + NODE + ' (' + process.version + ')\n');
  const shimStat = fs.statSync(SHIM);
  const shimHash = crypto.createHash('sha256').update(fs.readFileSync(SHIM)).digest('hex').slice(0, 12);
  process.stdout.write(' shim  : ' + SHIM + '\n');
  process.stdout.write('          ' + shimStat.size + ' bytes  sha256:' + shimHash + '  mtime:' + shimStat.mtime.toISOString() + '\n');
  const stale = stalenessNote();
  if (stale) process.stdout.write(' ' + stale + '\n');
  process.stdout.write(' 临时  : ' + TMP + '\n');
  process.stdout.write(' 时区  : ' + TEST_ZONES.length + ' 组\n');
  process.stdout.write('----------------------------------------------------------------------\n');

  if (SELFTEST) {
    process.stdout.write(' *** SELFTEST：shim 换成空操作替身，子进程 TZ 直接等于目标时区。\n');
    process.stdout.write('     预期：零硬差异（若出现差异，说明本测试自身的采集或比对有假阳性）。\n');
    for (const spec of TEST_ZONES) {
      compareZone(spec.zone, spec.zone, { note: 'selftest' + (spec.note ? '/' + spec.note : ''), perf: spec.perf });
    }
    const selFailed = results.filter((r) => !r.ok).length;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write('----------------------------------------------------------------------\n');
    process.stdout.write(' 用例: ' + results.length + '  失败: ' + selFailed + '  用时: ' + secs + 's\n');
    if (selFailed) {
      process.stdout.write('\n✗ SELFTEST FAIL（测试自身存在假阳性，先修测试再评判 shim）\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('\n✓ ALL OK（SELFTEST：' + results.length + ' 组零差异，差分引擎可信）\n');
    process.exitCode = 0;
    return;
  }

  for (const spec of TEST_ZONES) {
    compareZone(spec.zone, spec.hostTz, spec);
  }

  /* 守卫：非法 / 空 / 缺失 zone，重复注入 */
  if (!QUICK) {
    process.stdout.write('----------------------------------------------------------------------\n');
    guardCase('守卫 · 非法时区 Not/AZone 安静返回', 'Not/AZone', 'Asia/Shanghai', false, (d) => {
      const out = [];
      if (!Array.isArray(d.warnings) || d.warnings.length === 0) out.push('未给出 console.warn 告警');
      return out;
    });
    guardCase('守卫 · 空字符串时区安静返回', '', 'Asia/Shanghai', false, (d) => {
      const out = [];
      if (!Array.isArray(d.warnings) || d.warnings.length === 0) out.push('未给出 console.warn 告警');
      return out;
    });
    guardCase('守卫 · 缺少 __DSH_TZ_FIX_ZONE__ 安静返回', undefined, 'Asia/Shanghai', false, (d) => {
      const out = [];
      if (!Array.isArray(d.warnings) || d.warnings.length === 0) out.push('未给出 console.warn 告警');
      return out;
    });
    guardCase('守卫 · 正常安装 + 重复注入幂等', 'America/Los_Angeles', 'Asia/Shanghai', true, null);

    /* 显式覆盖：显式 timeZone 不得被覆盖 */
    const explicit = shimRun('America/Los_Angeles', 'Asia/Shanghai', {});
    const nresExp = nativeRun('America/Los_Angeles', false);
    if (explicit.ok && nresExp.ok) {
      const d = collectDiffs(nresExp.data.R, explicit.data.R)
        .filter((x) => !isNondeterministic(x.key))
        .filter((x) => !nameOnlyDiff(x.key, x.expected, x.actual));
      const sampleExplicit = explicit.data.R['intl|explicitUTC'];
      const ok = d.length === 0;
      process.stdout.write((ok ? '[ OK ] ' : '[FAIL] ') + '显式 timeZone 不被覆盖（intl|explicitUTC=' + fmt(sampleExplicit) + '）\n');
      if (ok) pass('显式 timeZone 不被覆盖'); else fail('显式 timeZone 不被覆盖', d.slice(0, 5).map((x) => x.key));
    }
  }

  /* 全时区冒烟（可选）：zones/ 下每个时区与真身比对 */
  if (ALL_ZONES && fs.existsSync(ZONES_DIR)) {
    process.stdout.write('----------------------------------------------------------------------\n');
    const files = fs.readdirSync(ZONES_DIR).filter((f) => /\.js$/.test(f));
    process.stdout.write(' 全时区冒烟对拍：' + files.length + ' 个时区文件（轻量模式，失败才输出）\n');
    let zoneFail = 0;
    let zoneRan = 0;
    const smokeCases = [];
    QUIET = true;
    const baseResults = results.length;
    const baseFail = hardFail;
    for (const file of files) {
      const text = fs.readFileSync(path.join(ZONES_DIR, file), 'utf8');
      const m = /(['"])([^'"]+)\1/.exec(text);
      const zone = m ? m[2] : null;
      if (!zone) continue;
      zoneRan += 1;
      const before = hardFail;
      try {
        compareZone(zone, 'Asia/Shanghai', { note: 'smoke', smoke: true });
      } catch (e) {
        hardFail += 1;
        zoneFail += 1;
        out('[FAIL] smoke ' + zone + ': ' + (e && e.message));
        continue;
      }
      if (hardFail > before) zoneFail += 1;
    }
    QUIET = false;
    /* 冒烟结果不计入主用例表 */
    results.length = baseResults;
    process.stdout.write(' 全时区冒烟：' + (zoneRan - zoneFail) + '/' + zoneRan + ' 通过\n');
    if (zoneFail > 0) {
      hardFail = baseFail + 1;
      fail('全时区冒烟', [zoneFail + '/' + zoneRan + ' 个时区存在差异']);
    }
  }

  /* 汇总 */
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write('----------------------------------------------------------------------\n');
  process.stdout.write(' soft（指纹类）差异总数: ' + softTotals.count + '（不影响退出码）\n');
  if (softTotals.samples.length) {
    for (const s of softTotals.samples) process.stdout.write('   ~ ' + s + '\n');
  }
  const failedCases = results.filter((r) => !r.ok);
  process.stdout.write(' 用例: ' + results.length + '  失败: ' + failedCases.length + '  用时: ' + seconds + 's\n');
  if (failedCases.length) {
    const byGroup = new Map();
    for (const f of failedCases) {
      for (const line of f.lines) {
        const m = /^([a-zA-Z]+)\|/.exec(line);
        if (!m) continue;
        byGroup.set(m[1], (byGroup.get(m[1]) || 0) + 1);
      }
    }
    if (byGroup.size) {
      const parts = [];
      for (const [k, v] of Array.from(byGroup.entries()).sort((a, b) => b[1] - a[1])) parts.push(k + '=' + v);
      process.stdout.write('差异面聚合: ' + parts.join('  ') + '\n');
    }
    process.stdout.write('\n失败用例：\n');
    for (const f of failedCases) {
      process.stdout.write('  - ' + f.name + '\n');
      for (const line of f.lines.slice(0, 16)) process.stdout.write('      ' + line + '\n');
    }
    process.stdout.write('\n✗ FAIL（' + failedCases.length + ' 个用例未通过）\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✓ ALL OK（' + results.length + ' 个用例，' + TEST_ZONES.length + ' 组时区与真身零硬差异）\n');
  process.exitCode = 0;
}

let PROBE_FILE = null;

main();

if (!KEEP) {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  try {
    /* 父目录空了就一起清掉，避免 tests/.tmp/selfcheck 里堆一堆空目录 */
    const parent = path.dirname(TMP);
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch (e) { /* 忽略 */ }
} else {
  process.stdout.write(' 临时目录保留：' + TMP + '\n');
}
