/*
 * tests/lib/probe-page.js —— 观测采集器（被 native / shim 两组以相同方式加载）
 *
 * 只采集「看到的事实」，不做任何判断；期望值一律由真身（TZ=<zone> 的 Node）提供。
 * 采集完成后挂载 globalThis.__COLLECT__()。
 */
(function () {
  'use strict';

  var SAMPLES = [
    '2026-01-15T12:00:00.000Z', '2026-03-08T09:59:59.000Z', '2026-03-08T10:00:00.000Z',
    '2026-03-08T10:30:00.000Z', '2026-07-15T12:00:00.000Z', '2026-10-25T00:30:00.000Z',
    '2026-11-01T08:59:59.000Z', '2026-11-01T09:00:00.000Z', '2026-11-01T09:30:00.000Z',
    '2025-12-31T23:59:59.000Z', '2026-04-05T15:00:00.000Z', '2026-09-06T14:00:00.000Z',
    '2000-02-29T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '2038-01-19T03:14:07.000Z',
    '1969-12-31T23:59:59.999Z'
  ];

  function sampleOne(iso) {
    var t = Date.parse(iso);
    var d = new Date(t);
    return {
      iso: iso,
      year: d.getFullYear(), month: d.getMonth(), date: d.getDate(), day: d.getDay(),
      hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds(), ms: d.getMilliseconds(),
      yearShort: d.getYear(), tzo: d.getTimezoneOffset(),
      toString: d.toString(), toDateString: d.toDateString(), toTimeString: d.toTimeString(),
      toLocaleString: d.toLocaleString(), toLocaleDateString: d.toLocaleDateString(),
      toLocaleTimeString: d.toLocaleTimeString(),
      localeWithOptions: d.toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'long' }),
      localeExplicitTz: d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }),
      isoString: d.toISOString(), json: JSON.stringify(d), valueOf: d.valueOf()
    };
  }

  function safe(fn) {
    try {
      var v = fn();
      if (v && typeof v === 'object' && typeof v.toISOString === 'function') {
        return v.toString() === 'Invalid Date' ? { invalid: true } : { iso: v.toISOString() };
      }
      if (typeof v === 'number' && !isFinite(v)) return { nan: true };
      return { value: v };
    } catch (e) {
      return { error: String(e && e.name) };
    }
  }

  var CONSTRUCT = [
    ['Y2026 M0 D15', function () { return new Date(2026, 0, 15); }],
    ['Y2026 M6 D15 H12', function () { return new Date(2026, 6, 15, 12); }],
    ['DST gap 02:30', function () { return new Date(2026, 2, 8, 2, 30); }],
    ['DST gap 02:00', function () { return new Date(2026, 2, 8, 2, 0, 0, 0); }],
    ['DST overlap 01:30', function () { return new Date(2026, 10, 1, 1, 30); }],
    ['DST overlap 01:00', function () { return new Date(2026, 10, 1, 1, 0, 0, 0); }],
    ['month 13', function () { return new Date(2026, 13, 1); }],
    ['month -1', function () { return new Date(2026, -1, 1); }],
    ['day 32', function () { return new Date(2026, 0, 32); }],
    ['day 0', function () { return new Date(2026, 0, 0); }],
    ['fractional ms 1500.7', function () { return new Date(2026, 0, 1, 0, 0, 0, 1500.7); }],
    ['year 99', function () { return new Date(99, 0, 1); }],
    ['NaN arg', function () { return new Date(2026, NaN, 1); }],
    ['Infinity arg', function () { return new Date(2026, Infinity, 1); }],
    ['one arg undefined', function () { return new Date(undefined); }],
    ['one arg string num', function () { return new Date('1768494600000'); }],
    ['local ISO', function () { return new Date('2026-01-15T00:00:00'); }],
    ['local ISO ms', function () { return new Date('2026-07-15 08:30:15.250'); }],
    ['zoned Z', function () { return new Date('2026-01-15T12:00:00Z'); }],
    ['zoned offset', function () { return new Date('2026-01-15T12:00:00+09:00'); }],
    ['legacy slash', function () { return new Date('2026/01/15 08:30:00'); }],
    ['long english', function () { return new Date('Jan 15 2026 08:30:00'); }],
    ['date only', function () { return new Date('2026-01-15'); }],
    ['copy ctor', function () { return new Date(new Date(1768494600000)); }]
  ];

  var PARSES = [
    '2026-01-15T00:00:00', '2026-01-15T00:00:00.000', '2026-07-15T08:30:15.250',
    '2026/01/15 08:30:00', 'Jan 15 2026 08:30:00', '2026-01-15T12:00:00Z',
    '2026-01-15T12:00:00+09:00', '2026-01-15', 'not a date', '', '2026-02-30',
    'Thu Jan 15 2026 00:00:00 GMT+0000', '2026-01-15T00:00:00-08:00'
  ];

  function setters() {
    return [
      ['setHours(9,0,0,0)', function () { var d = new Date(2026, 0, 15, 0, 0, 0, 0); return { d: d, r: d.setHours(9, 0, 0, 0) }; }],
      ['setDate(32)', function () { var d = new Date(2026, 0, 15); return { d: d, r: d.setDate(32) }; }],
      ['setMonth(DST)', function () { var d = new Date(2026, 0, 8, 2, 30); return { d: d, r: d.setMonth(2) }; }],
      ['setFullYear(2027)', function () { var d = new Date(2026, 11, 31, 23, 59); return { d: d, r: d.setFullYear(2027) }; }],
      ['setMinutes(90)', function () { var d = new Date(2026, 5, 1, 0, 0); return { d: d, r: d.setMinutes(90) }; }],
      ['setSeconds(90)', function () { var d = new Date(2026, 5, 1, 0, 0); return { d: d, r: d.setSeconds(90) }; }],
      ['setMilliseconds(1500)', function () { var d = new Date(2026, 5, 1, 0, 0); return { d: d, r: d.setMilliseconds(1500) }; }],
      ['setYear(99)', function () { var d = new Date(2026, 5, 1, 0, 0); return { d: d, r: d.setYear(99) }; }],
      ['setYear(2027)', function () { var d = new Date(2026, 5, 1, 0, 0); return { d: d, r: d.setYear(2027) }; }],
      ['setHours() 无参', function () { var d = new Date(2026, 5, 1, 5, 6, 7, 8); return { d: d, r: d.setHours() }; }],
      ['invalid setHours', function () { var d = new Date(NaN); return { d: d, r: d.setHours(9) }; }],
      ['invalid setDate', function () { var d = new Date(NaN); return { d: d, r: d.setDate(15) }; }],
      ['setDate 跨 DST', function () { var d = new Date(2026, 2, 7, 2, 30); return { d: d, r: d.setDate(9) }; }]
    ];
  }

  function intl() {
    var t = Date.parse('2026-01-15T12:00:00.000Z');
    function nameOf(opts) {
      return new Intl.DateTimeFormat('en-US', opts).formatToParts(t)
        .filter(function (p) { return p.type === 'timeZoneName'; })
        .map(function (p) { return p.value; }).join('');
    }
    return {
      resolved: safe(function () { return new Intl.DateTimeFormat().resolvedOptions().timeZone; }),
      defaultEn: safe(function () { return new Intl.DateTimeFormat('en-US').format(t); }),
      defaultZh: safe(function () { return new Intl.DateTimeFormat('zh-CN').format(t); }),
      withParts: safe(function () {
        return new Intl.DateTimeFormat('en-US', {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        }).format(t);
      }),
      nameLong: safe(function () { return nameOf({ timeZoneName: 'long' }); }),
      nameShort: safe(function () { return nameOf({ timeZoneName: 'short' }); }),
      explicitTokyo: safe(function () {
        return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(t);
      }),
      explicitUtc: safe(function () {
        return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(t);
      }),
      directCall: safe(function () { return Intl.DateTimeFormat('en-US').format(t); })
    };
  }

  function identity() {
    var out = {};
    out.protoTag = Object.prototype.toString.call(new Date(0));
    out.instanceofDate = new Date() instanceof Date;
    out.protoIsShared = Object.getPrototypeOf(new Date(0)) === Date.prototype;
    out.constructorMatch = new Date(0).constructor === Date;
    out.dateNowType = typeof Date.now();
    out.utcValue = Date.UTC(2026, 0, 15, 12, 0, 0);
    out.isoZero = new Date(0).toISOString();
    out.utcMethods = [0, 1768494600000].map(function (t) {
      var d = new Date(t);
      return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()].join(',');
    }).join(';');
    out.jsonRoundTrip = JSON.stringify({ d: new Date(1768494600000), n: new Date(0).valueOf() });
    out.dateCallType = typeof Date();
    out.dateCallParses = !isNaN(Date.parse(Date()));
    out.dateLength = Date.length;
    out.classExtends = (function () {
      try {
        var D = class D extends Date {};
        var d = new D(2026, 0, 15, 9, 30);
        return { isD: d instanceof D, isDate: d instanceof Date, iso: d.toISOString(), h: d.getHours() };
      } catch (e) { return { error: String(e && e.name) }; }
    })();
    out.invalid = {
      hours: String(new Date(NaN).getHours()),
      tzo: String(new Date(NaN).getTimezoneOffset()),
      str: new Date(NaN).toString(),
      isoThrows: (function () { try { new Date(NaN).toISOString(); return false; } catch (e) { return true; } })()
    };
    out.badThis = (function () {
      try { Date.prototype.getHours.call({}); return 'no-throw'; } catch (e) { return e && e.name; }
    })();
    out.perf = (function () {
      var t0 = Date.now();
      var d = new Date(2026, 5, 1, 12, 0, 0);
      var acc = 0;
      for (var i = 0; i < 100000; i += 1) acc += d.getHours();
      return { ms: Date.now() - t0, acc: acc };
    })();
    var offsets = {};
    for (var m = 0; m < 12; m += 1) {
      for (var day = 1; day <= 28; day += 9) {
        var tt = new Date(2026, m, day, 12, 0, 0);
        offsets[String(tt.getTimezoneOffset())] = true;
      }
    }
    out.offsets2026 = Object.keys(offsets).map(Number).sort(function (a, b) { return a - b; });
    return out;
  }

  globalThis.__COLLECT__ = function () {
    return {
      samples: SAMPLES.map(sampleOne),
      construct: CONSTRUCT.map(function (c) { return { label: c[0], out: safe(c[1]) }; }),
      parse: PARSES.map(function (s) { var v = Date.parse(s); return { input: s, value: isFinite(v) ? v : 'Invalid Date' }; }),
      setters: setters().map(function (c) {
        var r = c[1]();
        return { label: c[0], ret: isFinite(r.r) ? r.r : 'NaN', value: safe(function () { return r.d; }) };
      }),
      intl: intl(),
      identity: identity()
    };
  };
})();
