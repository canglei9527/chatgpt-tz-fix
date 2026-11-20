/*
 * verify-fingerprint.js —— 在「已被时区伪装」的页面环境中采集原生行为观测值。
 *
 * 设计原则：本文件只采集「看到的事实」，不做任何判断；判断与参考值统一由 verify.js
 * 在未伪装的宿主页面里用原生 Intl（显式 timeZone）独立重建后比对。
 * 这样两边的算法实现互相独立，任何一边写错都会暴露为差异。
 */
(function () {
  'use strict';

  var SAMPLES = [
    '2026-01-15T12:00:00.000Z',
    '2026-03-08T09:59:59.000Z',
    '2026-03-08T10:00:00.000Z',
    '2026-03-08T10:30:00.000Z',
    '2026-07-15T12:00:00.000Z',
    '2026-10-25T00:30:00.000Z',
    '2026-11-01T08:59:59.000Z',
    '2026-11-01T09:00:00.000Z',
    '2026-11-01T09:30:00.000Z',
    '2025-12-31T23:59:59.000Z',
    '2026-04-05T15:00:00.000Z',
    '2026-09-06T14:00:00.000Z',
    '2000-02-29T00:00:00.000Z',
    '1970-01-01T00:00:00.000Z',
    '2038-01-19T03:14:07.000Z'
  ];

  function sampleOne(iso) {
    var t = Date.parse(iso);
    var d = new Date(t);
    return {
      iso: iso,
      t: t,
      year: d.getFullYear(),
      month: d.getMonth(),
      date: d.getDate(),
      day: d.getDay(),
      hours: d.getHours(),
      minutes: d.getMinutes(),
      seconds: d.getSeconds(),
      ms: d.getMilliseconds(),
      yearShort: d.getYear(),
      tzo: d.getTimezoneOffset(),
      toString: d.toString(),
      toDateString: d.toDateString(),
      toTimeString: d.toTimeString(),
      toLocaleString: d.toLocaleString(),
      toLocaleDateString: d.toLocaleDateString(),
      toLocaleTimeString: d.toLocaleTimeString(),
      isoString: d.toISOString(),
      utcHours: d.getUTCHours(),
      json: JSON.stringify(d)
    };
  }

  /* ---------- 构造器 / 解析 / 设置器 ---------- */

  function safe(fn) {
    try {
      var v = fn();
      if (v && typeof v === 'object' && typeof v.toISOString === 'function') {
        return v.toString() === 'Invalid Date' ? { invalid: true } : { iso: v.toISOString() };
      }
      return { value: v };
    } catch (e) {
      return { error: String(e && e.message || e).slice(0, 160) };
    }
  }

  var CONSTRUCT_CASES = [
    ['Y2026 M0 D15', function () { return new Date(2026, 0, 15); }],
    ['Y2026 M6 D15 H12', function () { return new Date(2026, 6, 15, 12); }],
    ['DST-gap 2026-03-08 02:30', function () { return new Date(2026, 2, 8, 2, 30); }],
    ['DST-gap 2026-03-08 02:00', function () { return new Date(2026, 2, 8, 2, 0, 0, 0); }],
    ['DST-overlap 2026-11-01 01:30', function () { return new Date(2026, 10, 1, 1, 30); }],
    ['DST-overlap 2026-11-01 01:00', function () { return new Date(2026, 10, 1, 1, 0, 0, 0); }],
    ['overflow month 13', function () { return new Date(2026, 13, 1); }],
    ['negative month -1', function () { return new Date(2026, -1, 1); }],
    ['overflow day 32', function () { return new Date(2026, 0, 32); }],
    ['fractional ms', function () { return new Date(2026, 0, 1, 0, 0, 0, 1500.7); }],
    ['NaN arg', function () { return new Date(2026, NaN, 1); }],
    ['local ISO string', function () { return new Date('2026-01-15T00:00:00'); }],
    ['local ISO with ms', function () { return new Date('2026-07-15 08:30:15.250'); }],
    ['zoned ISO string', function () { return new Date('2026-01-15T12:00:00Z'); }],
    ['zoned ISO offset', function () { return new Date('2026-01-15T12:00:00+09:00'); }],
    ['legacy date string', function () { return new Date('2026/01/15 08:30:00'); }],
    ['long english string', function () { return new Date('Jan 15 2026 08:30:00'); }],
    ['date-only ISO', function () { return new Date('2026-01-15'); }]
  ];

  var PARSE_CASES = [
    '2026-01-15T00:00:00',
    '2026-01-15T00:00:00.000',
    '2026-07-15T08:30:15.250',
    '2026/01/15 08:30:00',
    'Jan 15 2026 08:30:00',
    '2026-01-15T12:00:00Z',
    '2026-01-15T12:00:00+09:00',
    '2026-01-15',
    'not a date',
    ''
  ];

  function setterCases() {
    return [
      ['setHours(9,0,0,0)', function () { var d = new Date(2026, 0, 15, 0, 0, 0, 0); d.setHours(9, 0, 0, 0); return d; }],
      ['setDate(32) overflow', function () { var d = new Date(2026, 0, 15); d.setDate(32); return d; }],
      ['setMonth(DST boundary 2)', function () { var d = new Date(2026, 0, 8, 2, 30); d.setMonth(2); return d; }],
      ['setFullYear(2027)', function () { var d = new Date(2026, 11, 31, 23, 59); d.setFullYear(2027); return d; }],
      ['setMinutes(90)', function () { var d = new Date(2026, 5, 1, 0, 0); d.setMinutes(90); return d; }],
      ['invalid date setHours', function () { var d = new Date(NaN); d.setHours(9); return d; }],
      ['invalid date setDate', function () { var d = new Date(NaN); d.setDate(15); return d; }]
    ];
  }

  function intlCases() {
    var t = Date.parse('2026-01-15T12:00:00.000Z');
    return {
      defaultFormat: safe(function () { return new Intl.DateTimeFormat('en-US').format(t); }),
      defaultFormatZh: safe(function () { return new Intl.DateTimeFormat('zh-CN').format(t); }),
      resolved: safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }),
      nameLong: safe(function () { return new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(t).filter(function (p) { return p.type === 'timeZoneName'; }).map(function (p) { return p.value; }).join(''); }),
      nameShort: safe(function () { return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(t).filter(function (p) { return p.type === 'timeZoneName'; }).map(function (p) { return p.value; }).join(''); }),
      explicitTokyo: safe(function () { return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(t); }),
      explicitUTC: safe(function () { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(t); }),
      explicitKyiv: safe(function () { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', dateStyle: 'full', timeStyle: 'long' }).format(t); }),
      directCall: safe(function () { return Intl.DateTimeFormat('en-US').format(t); })
    };
  }

  function guards() {
    var out = {};
    var origProto = Object.getPrototypeOf(new Date(0));
    out.dateProtoIsNative = origProto === Date.prototype;
    out.protoTag = Object.prototype.toString.call(new Date(0));
    out.instanceofDate = new Date() instanceof Date;
    out.jsonRoundTrip = JSON.stringify({ d: new Date(0) });
    out.isoZero = new Date(0).toISOString();
    out.utcMethods = [new Date(0).getUTCFullYear(), new Date(0).getUTCMonth(), new Date(0).getUTCDate(), new Date(0).getUTCHours()].join(',');
    out.dateNowType = typeof Date.now();
    out.dateUtc = Date.UTC(2026, 0, 15, 12, 0, 0);
    out.distinguishClass = (function () {
      try {
        class D extends Date {}
        var d = new D(2026, 0, 15, 9, 30);
        return { ok: d instanceof D && d instanceof Date, iso: d.toISOString(), h: d.getHours() };
      } catch (e) { return { error: String(e && e.message || e).slice(0, 120) }; }
    })();
    out.callNoNew = (function () {
      var s;
      try { s = Date(); } catch (e) { return { error: String(e).slice(0, 120) }; }
      return { type: typeof s, sample: String(s).slice(0, 60), parses: !isNaN(Date.parse(s)) };
    })();
    out.invalid = {
      getHours: new Date(NaN).getHours(),
      getTimezoneOffset: new Date(NaN).getTimezoneOffset(),
      toString: new Date(NaN).toString(),
      toISOStringThrows: (function () { try { new Date(NaN).toISOString(); return false; } catch (e) { return true; } })()
    };
    out.badThis = (function () {
      try { Date.prototype.getHours.call({}); return { threw: false }; } catch (e) { return { threw: true, name: e && e.name }; }
    })();
    out.shimMeta = (function () {
      var m = globalThis.__DSH_TZ_FIX__;
      return m ? { present: true, version: m.version, zone: m.zone, installedAtType: typeof m.installedAt } : { present: false };
    })();
    out.offsetRange = (function () {
      var mins = [];
      for (var i = 0; i < out.span; i += 1) { mins.push(0); }
      return mins.length;
    })();
    delete out.offsetRange;
    out.span = 0;
    delete out.span;

    // 100k 次 getHours 性能
    var t0 = performance.now();
    var d0 = new Date(2026, 5, 1, 12, 0, 0);
    var acc = 0;
    for (var i = 0; i < 100000; i += 1) { acc += d0.getHours(); }
    out.perf100kMs = Math.round((performance.now() - t0) * 100) / 100;
    out.perfAcc = acc;

    // getTimezoneOffset 全年扫描（每 6 小时），用于验证 DST 切换次数
    var offsets = {};
    var y0 = 2026;
    for (var m = 0; m < 12; m += 1) {
      for (var day = 1; day <= 28; day += 9) {
        var k = new Date(y0, m, day, 12, 0, 0).getTimezoneOffset();
        offsets[String(k)] = true;
      }
    }
    out.distinctOffsets2026 = Object.keys(offsets).map(Number).sort(function (a, b) { return a - b; });
    return out;
  }

  /**
   * 采集当前（可能已被伪装的）页面环境中的一切观测值。
   * @param {string} zone 目标 IANA 时区（仅用于记录，不参与计算）
   */
  function collect(zone) {
    var out = {
      requestedZone: zone,
      collectedAt: Date.now(),
      samples: SAMPLES.map(sampleOne),
      construct: CONSTRUCT_CASES.map(function (c) { return { label: c[0], result: safe(c[1]) }; }),
      setters: setterCases().map(function (c) { return { label: c[0], result: safe(c[1]) }; }),
      parse: PARSE_CASES.map(function (s) {
        var v = Date.parse(s);
        return { input: s, value: isFinite(v) ? v : 'Invalid Date' };
      }),
      intl: intlCases(),
      guards: guards()
    };
    return out;
  }

  globalThis.TZFingerprint = { collect: collect, SAMPLES: SAMPLES };
})();
