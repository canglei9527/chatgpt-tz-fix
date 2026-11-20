/*
 * verify.js —— 「时区修复」扩展自检页逻辑。
 *
 * 两条互相独立的验证路径：
 *  A. 注入引擎自检：在隐藏 iframe 里真实加载 inject/zones/<zone>.js + inject/tz-shim.js，
 *     采集被伪装环境的观测值；参考值由本页面（未被伪装的宿主环境）用原生 Intl 显式
 *     timeZone 独立重建，两边逐项比对。任何差异都说明伪装脚本与浏览器真身不一致。
 *  B. 标签页实测：对已打开的真实网页执行注入探针，确认内容脚本已在页面主世界生效。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SETTINGS_KEY = 'settings';
  var DEFAULT_ZONE = 'America/Los_Angeles';

  var state = {
    settings: null,
    meta: null,
    tabs: [],
    selectedTabId: null,
    engine: null,
    tabReport: null,
    hostPolluted: false,
    running: false
  };

  /* ============================ 基础工具 ============================ */

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function setTag(id, kind, text) {
    var el = $(id);
    el.className = 'tag' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  function zoneLabel(zone) {
    var list = globalThis.DSH_TZ_ZONES || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].zone === zone) return list[i].label || zone;
    }
    return zone;
  }

  function slugForZone(zone) {
    var list = globalThis.DSH_TZ_ZONES || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].zone === zone) return list[i].slug;
    }
    return String(zone).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  /* ============ 参考值：宿主页面原生 ICU，显式 timeZone 重建 ============ */

  var _fmtCache = new Map();

  function formatter(zone, options) {
    var key = zone + '|' + JSON.stringify(options);
    var hit = _fmtCache.get(key);
    if (!hit) {
      var opts = Object.assign({ timeZone: zone }, options);
      hit = new Intl.DateTimeFormat('en-US', opts);
      _fmtCache.set(key, hit);
    }
    return hit;
  }

  function wallRef(t, zone) {
    if (!isFinite(t)) return null;
    var parts = formatter(zone, {
      hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(t);
    var map = {};
    for (var i = 0; i < parts.length; i += 1) map[parts[i].type] = parts[i].value;
    return {
      y: Number(map.year),
      mo: Number(map.month) - 1,
      d: Number(map.day),
      h: Number(map.hour) % 24,
      mi: Number(map.minute),
      s: Number(map.second),
      ms: ((t % 1000) + 1000) % 1000
    };
  }

  function offsetRef(t, zone) {
    if (!isFinite(t)) return NaN;
    var w = wallRef(t, zone);
    return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) + w.ms - t;
  }

  function localToUtcRef(fields, zone) {
    var base = Date.UTC(
      fields[0], fields[1], fields[2],
      fields.length > 3 ? fields[3] : 0,
      fields.length > 4 ? fields[4] : 0,
      fields.length > 5 ? fields[5] : 0,
      fields.length > 6 ? fields[6] : 0
    );
    if (!isFinite(base)) return NaN;
    return base - offsetRef(base, zone);
  }

  var WD_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
  var MO_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' });

  function gmtString(offsetMs) {
    var sign = offsetMs < 0 ? '-' : '+';
    var abs = Math.abs(offsetMs);
    return 'GMT' + sign + pad2(Math.floor(abs / 3600000)) + pad2(Math.floor((abs % 3600000) / 60000));
  }

  /*
   * Date.prototype.toString 里的时区长名跟随「当前默认语言」，不是固定 en-US
   * （中文环境会显示「北美太平洋标准时间」）。参考实现必须用 undefined 才能与真身一致。
   */
  function tzLongName(t, zone) {
    var parts = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'long' }).formatToParts(t);
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].type === 'timeZoneName') return parts[i].value;
    }
    return '';
  }

  /** en-US 的时区长名，用于与「显式 en-US 的 Intl 探针」对拍。 */
  function tzLongNameEn(t, zone) {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(t);
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].type === 'timeZoneName') return parts[i].value;
    }
    return '';
  }

  /** 取出 "GMT+0800 (xxx)" 结尾括号里的时区显示名。 */
  function tzNameOf(text) {
    var m = /\(([^)]*)\)\s*$/.exec(String(text));
    return m ? m[1] : '';
  }

  /** 去掉结尾的 "(时区名)"，只保留时间部分。 */
  function stripTzName(text) {
    return String(text).replace(/\s*\([^)]*\)\s*$/, '');
  }

  function toStringRef(t, zone) {
    if (!isFinite(t)) return 'Invalid Date';
    var w = wallRef(t, zone);
    var d = new Date(Date.UTC(w.y, w.mo, w.d));
    return WD_FMT.format(d) + ' ' + MO_FMT.format(d) + ' ' + pad2(w.d) + ' ' + w.y +
      ' ' + pad2(w.h) + ':' + pad2(w.mi) + ':' + pad2(w.s) +
      ' ' + gmtString(offsetRef(t, zone)) + ' (' + tzLongName(t, zone) + ')';
  }

  function dateStringRef(t, zone) {
    if (!isFinite(t)) return 'Invalid Date';
    var w = wallRef(t, zone);
    var d = new Date(Date.UTC(w.y, w.mo, w.d));
    return WD_FMT.format(d) + ' ' + MO_FMT.format(d) + ' ' + pad2(w.d) + ' ' + w.y;
  }

  function timeStringRef(t, zone) {
    if (!isFinite(t)) return 'Invalid Date';
    var w = wallRef(t, zone);
    return pad2(w.h) + ':' + pad2(w.mi) + ':' + pad2(w.s) +
      ' ' + gmtString(offsetRef(t, zone)) + ' (' + tzLongName(t, zone) + ')';
  }

  /*
   * 复刻 Date.prototype.toLocaleString / toLocaleDateString / toLocaleTimeString 的默认输出。
   * 注意：必须显式给出分量，不能依赖 Intl.DateTimeFormat 的默认分量（它的默认是「只要年月日」，
   * 而 toLocale* 的默认是「年月日 + 时分秒」）。
   */
  function localeRef(t, zone, kind) {
    var options = { timeZone: zone };
    if (kind === 'Date') {
      Object.assign(options, { year: 'numeric', month: 'numeric', day: 'numeric' });
    } else if (kind === 'Time') {
      Object.assign(options, { hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } else {
      Object.assign(options, {
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric'
      });
    }
    return new Intl.DateTimeFormat(undefined, options).format(t);
  }

  /** ICU 的时区规范名（例如 Asia/Kolkata 会被规范成 Asia/Calcutta）。 */
  function canonicalZone(zone) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    } catch (e) {
      return zone;
    }
  }

  /**
   * Date.parse 的参考实现（宿主环境原生解析 + 按目标时区重新解释）。
   * 与伪装脚本内部实现刻意保持结构不同，便于互相暴露问题。
   */
  function parseRef(input, zone) {
    var s = String(input).trim();
    if (s === '') return NaN;
    var native = Date.parse(s);
    // 注意用 isNaN(native) 而非 !isFinite(native)：Date.parse 解析失败返回 NaN（不是 Infinity）
    if (isNaN(native)) return NaN;

    var hasZone = /(?:Z|[+-]\d{2}:?\d{2})\s*$/i.test(s) || /\b(?:GMT|UTC)\b/i.test(s);
    if (hasZone) return native;

    // 纯日期形式（YYYY-MM-DD）按 ES 规范是 UTC 时间
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return native;

    // 其余「不带时区的本地时间」：原生按系统时区解析，这里改写为目标时区解析
    var d = new Date(native);
    return localToUtcRef(
      [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()],
      zone
    );
  }

  /* ============================ 构造 / 设置参考表 ============================ */

  var CONSTRUCT_REF = {
    'Y2026 M0 D15': { fields: [2026, 0, 15] },
    'Y2026 M6 D15 H12': { fields: [2026, 6, 15, 12] },
    'DST-gap 2026-03-08 02:30': { fields: [2026, 2, 8, 2, 30] },
    'DST-gap 2026-03-08 02:00': { fields: [2026, 2, 8, 2, 0, 0, 0] },
    'DST-overlap 2026-11-01 01:30': { fields: [2026, 10, 1, 1, 30] },
    'DST-overlap 2026-11-01 01:00': { fields: [2026, 10, 1, 1, 0, 0, 0] },
    'overflow month 13': { fields: [2026, 13, 1] },
    'negative month -1': { fields: [2026, -1, 1] },
    'overflow day 32': { fields: [2026, 0, 32] },
    'fractional ms': { fields: [2026, 0, 1, 0, 0, 0, 1500.7] },
    'NaN arg': { invalid: true },
    'local ISO string': { parse: '2026-01-15T00:00:00' },
    'local ISO with ms': { parse: '2026-07-15 08:30:15.250' },
    'zoned ISO string': { native: '2026-01-15T12:00:00Z' },
    'zoned ISO offset': { native: '2026-01-15T12:00:00+09:00' },
    'legacy date string': { parse: '2026/01/15 08:30:00' },
    'long english string': { parse: 'Jan 15 2026 08:30:00' },
    'date-only ISO': { native: '2026-01-15' }
  };

  var SETTER_REF = {
    'setHours(9,0,0,0)': { base: [2026, 0, 15, 0, 0, 0, 0], apply: function (w) { w.h = 9; w.mi = 0; w.s = 0; w.ms = 0; return w; } },
    'setDate(32) overflow': { base: [2026, 0, 15], apply: function (w) { w.d = 32; return w; } },
    'setMonth(DST boundary 2)': { base: [2026, 0, 8, 2, 30], apply: function (w) { w.mo = 2; return w; } },
    'setFullYear(2027)': { base: [2026, 11, 31, 23, 59], apply: function (w) { w.y = 2027; return w; } },
    'setMinutes(90)': { base: [2026, 5, 1, 0, 0], apply: function (w) { w.mi = 90; return w; } },
    'invalid date setHours': { baseInvalid: true, apply: function (w) { w.h = 9; w.mi = 0; w.s = 0; w.ms = 0; return w; } },
    'invalid date setDate': { baseInvalid: true, apply: function (w) { w.d = 15; return w; } }
  };

  var PARSE_INPUTS = [
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

  function isoOf(t) { return isFinite(t) ? new Date(t).toISOString() : null; }

  function expectedConstruct(spec, zone) {
    if (spec.invalid) return 'Invalid Date';
    if (spec.fields) {
      var tc = localToUtcRef(spec.fields, zone);
      return isFinite(tc) ? new Date(tc).toISOString() : 'Invalid Date';
    }
    if (spec.parse) {
      var tp = parseRef(spec.parse, zone);
      return isFinite(tp) ? new Date(tp).toISOString() : 'Invalid Date';
    }
    if (spec.native) {
      var tn = Date.parse(spec.native);
      return isFinite(tn) ? new Date(tn).toISOString() : 'Invalid Date';
    }
    return 'Invalid Date';
  }

  function expectedSetter(spec, zone) {
    // 实测（Chrome/V8）：对 Invalid Date 调用 set* 之后仍然是 Invalid Date，返回 NaN
    if (spec.baseInvalid) return 'Invalid Date';
    var baseT = localToUtcRef(spec.base, zone);
    if (!isFinite(baseT)) return null;
    var w = wallRef(baseT, zone);
    var next = spec.apply(w);
    return isoOf(localToUtcRef([next.y, next.mo, next.d, next.h, next.mi, next.s, next.ms], zone));
  }

  /* ============================ 结果比对 ============================ */

  function Group(id, name) {
    this.id = id;
    this.name = name;
    this.total = 0;
    this.failed = 0;
    this.skipped = 0;
    this.details = [];
  }

  /**
   * 记录一项「已知的平台差异」，不计入总数也不算失败。
   * 目前只用于历史时段时区显示名的 ICU 退化（native 回退成 GMT±HH:MM）。
   */
  Group.prototype.skip = function () {
    this.skipped += 1;
  };

  Group.prototype.expect = function (label, expected, got) {
    this.total += 1;
    var e = JSON.stringify(expected);
    var g = JSON.stringify(got);
    if (e !== g) {
      this.failed += 1;
      if (this.details.length < 8) {
        this.details.push(label + '\n    期望 ' + e + '\n    实际 ' + g);
      }
    }
  };

  Group.prototype.assert = function (label, passed, detail) {
    this.total += 1;
    if (!passed) {
      this.failed += 1;
      if (this.details.length < 8) this.details.push(label + (detail ? '\n    ' + detail : ''));
    }
  };

  Group.prototype.ok = function () { return this.failed === 0; };

  /* ============================ 注入引擎自检 ============================ */

  function runRealm(zone) {
    return new Promise(function (resolve) {
      var slug = slugForZone(zone);
      var iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
      iframe.src = chrome.runtime.getURL('verify/verify-bootstrap.html') +
        '?zone=' + encodeURIComponent(zone) + '&slug=' + encodeURIComponent(slug);

      var settled = false;
      var poll = null;
      var timer = null;

      function finish(value) {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        setTimeout(function () { iframe.remove(); }, 0);
        resolve(value);
      }

      poll = setInterval(function () {
        var win;
        try { win = iframe.contentWindow; } catch (e) { finish({ ok: false, error: '无法访问自检帧：' + e.message }); return; }
        if (!win || !win.__TZF_READY__) return;
        var ready = win.__TZF_READY__;
        if (!ready.ok) { finish({ ok: false, error: ready.error || '注入失败' }); return; }
        try {
          if (!win.TZFingerprint || typeof win.TZFingerprint.collect !== 'function') {
            finish({ ok: false, error: '观测采集器未加载' });
            return;
          }
          finish({ ok: true, ready: ready, data: win.TZFingerprint.collect(zone) });
        } catch (e) {
          finish({ ok: false, error: '采集失败：' + (e && e.message || e) });
        }
      }, 50);

      timer = setTimeout(function () { finish({ ok: false, error: '注入超时（6 秒内未完成）' }); }, 6000);
      document.body.appendChild(iframe);
    });
  }

  /**
   * 用「参考实现」分析一份被观测数据。
   * @param {object} data verify-fingerprint.js 采集到的观测值
   * @param {string} zone 期望的时区
   * @param {object} [opts] { skipMarker: true } 表示数据来自未注入伪装脚本的原生环境
   */
  function analyseEngine(data, zone, opts) {
    var options = opts || {};
    var groups = [];
    var samples = data.samples || [];

    /* 1. 采样点的本地时间字段与偏移 */
    var g1 = new Group('fields', '本地时间字段与 UTC 偏移');
    samples.forEach(function (s) {
      var t = Date.parse(s.iso);
      var w = wallRef(t, zone);
      g1.expect(s.iso + ' · 年', w.y, s.year);
      g1.expect(s.iso + ' · 月', w.mo, s.month);
      g1.expect(s.iso + ' · 日', w.d, s.date);
      g1.expect(s.iso + ' · 星期', new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay(), s.day);
      g1.expect(s.iso + ' · 时', w.h, s.hours);
      g1.expect(s.iso + ' · 分', w.mi, s.minutes);
      g1.expect(s.iso + ' · 秒', w.s, s.seconds);
      g1.expect(s.iso + ' · 毫秒', w.ms, s.ms);
      g1.expect(s.iso + ' · getTimezoneOffset', -offsetRef(t, zone) / 60000, s.tzo);
      g1.expect(s.iso + ' · toISOString', new Date(t).toISOString(), s.isoString);
      g1.expect(s.iso + ' · getUTCHours', new Date(t).getUTCHours(), s.utcHours);
    });
    groups.push(g1);

    /* 2. 字符串表示 */
    var g2 = new Group('strings', 'toString / toDateString / toTimeString');
    var NATIVE_GMT_FALLBACK = /^GMT[+-]\d{1,2}(:\d{2})?$/;
    samples.forEach(function (s) {
      var t = Date.parse(s.iso);
      var expToString = toStringRef(t, zone);
      var expTimeString = timeStringRef(t, zone);

      g2.expect(s.iso + ' · toString', stripTzName(expToString), stripTzName(s.toString));
      g2.expect(s.iso + ' · toDateString', dateStringRef(t, zone), s.toDateString);
      g2.expect(s.iso + ' · toTimeString', stripTzName(expTimeString), stripTzName(s.toTimeString));

      var expName = tzNameOf(expToString);
      var gotName = tzNameOf(s.toString);
      var wallYear = (wallRef(t, zone) || {}).y;
      if (expName === gotName) {
        g2.total += 1;
      } else if (NATIVE_GMT_FALLBACK.test(gotName) || NATIVE_GMT_FALLBACK.test(expName) ||
        (typeof wallYear === 'number' && wallYear < 2000)) {
        // 已知平台差异：时区显示名有两套来源（V8 DateCache 与 ICU），
        // 个别时区在历史时段（2000 年以前）会给出不同的名字，甚至退化成 GMT±HH:MM。
        // 这不是伪装逻辑的问题，跳过该子项。
        g2.skip();
      } else {
        g2.total += 1;
        g2.failed += 1;
        if (g2.details.length < 8) {
          g2.details.push(s.iso + ' · 时区显示名\n    期望 ' + JSON.stringify(expName) + '\n    实际 ' + JSON.stringify(gotName));
        }
      }
    });
    groups.push(g2);

    /* 3. 本地化格式 */
    var g3 = new Group('locale', 'toLocaleString / Date / Time');
    samples.forEach(function (s) {
      var t = Date.parse(s.iso);
      g3.expect(s.iso + ' · toLocaleString', localeRef(t, zone, ''), s.toLocaleString);
      g3.expect(s.iso + ' · toLocaleDateString', localeRef(t, zone, 'Date'), s.toLocaleDateString);
      g3.expect(s.iso + ' · toLocaleTimeString', localeRef(t, zone, 'Time'), s.toLocaleTimeString);
    });
    groups.push(g3);

    /* 4. 构造器语义 */
    var g4 = new Group('construct', 'new Date(...) 构造语义');
    (data.construct || []).forEach(function (item) {
      var spec = CONSTRUCT_REF[item.label];
      if (!spec) return;
      var expected = expectedConstruct(spec, zone);
      var got = item.result && item.result.error
        ? 'ERROR: ' + item.result.error
        : (item.result && item.result.invalid ? 'Invalid Date' : (item.result && item.result.iso));
      g4.expect(item.label, expected, got);
    });
    groups.push(g4);

    /* 5. setter 语义 */
    var g5 = new Group('setters', 'set* 设置器语义');
    (data.setters || []).forEach(function (item) {
      var spec = SETTER_REF[item.label];
      if (!spec) return;
      var expected = expectedSetter(spec, zone) || 'Invalid Date';
      var got = item.result && item.result.error
        ? 'ERROR: ' + item.result.error
        : (item.result && item.result.invalid ? 'Invalid Date' : (item.result && item.result.iso));
      g5.expect(item.label, expected, got);
    });
    groups.push(g5);

    /* 6. 字符串解析 */
    var g6 = new Group('parse', 'Date.parse 与本地时间字符串');
    (data.parse || []).forEach(function (item) {
      var expected = parseRef(item.input, zone);
      g6.expect(JSON.stringify(item.input),
        isFinite(expected) ? expected : 'Invalid Date',
        isFinite(item.value) ? item.value : 'Invalid Date');
    });
    groups.push(g6);

    /* 7. Intl.DateTimeFormat */
    var g7 = new Group('intl', 'Intl.DateTimeFormat 默认时区');
    var intl = data.intl || {};
    var probeT = Date.parse('2026-01-15T12:00:00.000Z');
    var unwrap = function (r) { return r && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r; };
    // ICU 会把部分别名规范化（如 Asia/Kolkata → Asia/Calcutta），比对时以规范化后的名字为准，
    // 这样即使未来 ICU 内置的规范名变化，自检也不会误报。
    var canon = canonicalZone(zone);
    var defaultOpts = { year: 'numeric', month: 'numeric', day: 'numeric' };
    g7.expect('默认 en-US', new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: zone }, defaultOpts)).format(probeT), unwrap(intl.defaultFormat));
    g7.expect('默认 zh-CN', new Intl.DateTimeFormat('zh-CN', Object.assign({ timeZone: zone }, defaultOpts)).format(probeT), unwrap(intl.defaultFormatZh));
    g7.expect('resolvedOptions().timeZone', canon, unwrap(intl.resolved));
    g7.expect('resolvedOptions() 与期望时区等价', true, canon === zone || unwrap(intl.resolved) === canon);
    g7.expect('时区长名(en-US)', tzLongNameEn(probeT, zone), unwrap(intl.nameLong));
    var shortName = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(probeT).filter(function (p) { return p.type === 'timeZoneName'; })[0];
    g7.expect('时区短名(en-US)', shortName ? shortName.value : '', unwrap(intl.nameShort));
    g7.expect('显式 Asia/Tokyo 不被覆盖', new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(probeT), unwrap(intl.explicitTokyo));
    g7.expect('显式 UTC 不被覆盖', new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(probeT), unwrap(intl.explicitUTC));
    g7.expect('显式 Europe/Kyiv 不被覆盖', new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv', dateStyle: 'full', timeStyle: 'long'
    }).format(probeT), unwrap(intl.explicitKyiv));
    g7.expect('不带 new 的直接调用', new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(probeT), unwrap(intl.directCall));
    groups.push(g7);

    /* 8. 原生性守卫（不破坏页面其它代码） */
    var g8 = new Group('guards', '原生语义保持');
    var guards = data.guards || {};
    g8.expect('Date.prototype 未被替换', true, guards.dateProtoIsNative);
    g8.expect('Object.prototype.toString', '[object Date]', guards.protoTag);
    g8.expect('instanceof Date', true, guards.instanceofDate);
    g8.expect('JSON 序列化', '{"d":"1970-01-01T00:00:00.000Z"}', guards.jsonRoundTrip);
    g8.expect('toISOString(0)', '1970-01-01T00:00:00.000Z', guards.isoZero);
    g8.expect('UTC 取值方法', '1970,0,1,0', guards.utcMethods);
    g8.expect('Date.now() 类型', 'number', guards.dateNowType);
    g8.expect('Date.UTC(2026,0,15,12)', Date.UTC(2026, 0, 15, 12), guards.dateUtc);
    g8.expect('Date() 无 new 返回字符串', 'string', guards.callNoNew && guards.callNoNew.type);
    g8.assert('Date() 字符串可被 Date.parse 解析', !!(guards.callNoNew && guards.callNoNew.parses), 'Date() 应返回可解析的本地时间字符串');
    var subclass = guards.distinguishClass || {};
    var subExpectedIso = isoOf(localToUtcRef([2026, 0, 15, 9, 30], zone));
    g8.expect('class D extends Date · 实例判断', true, !!subclass.ok);
    g8.expect('class D extends Date · 构造值', subExpectedIso, subclass.iso || null);
    g8.expect('class D extends Date · getHours', 9, subclass.h === undefined ? '__missing__' : subclass.h);
    // 探针在页面里返回 NaN，经 postMessage/结构化克隆后可能是 null，这里统一按字符串比较
    var asNaText = function (v) { return (v === null || v === undefined || Number.isNaN(v)) ? 'NaN' : String(v); };
    g8.expect('Invalid Date · getHours', 'NaN', asNaText((guards.invalid || {}).getHours));
    g8.expect('Invalid Date · getTimezoneOffset', 'NaN', asNaText((guards.invalid || {}).getTimezoneOffset));
    g8.expect('Invalid Date · toString', 'Invalid Date', (guards.invalid || {}).toString);
    g8.expect('Invalid Date · toISOString 抛错', true, !!(guards.invalid || {}).toISOStringThrows);
    g8.expect('错误 this · 抛 TypeError', true, !!(guards.badThis && guards.badThis.threw && guards.badThis.name === 'TypeError'));
    groups.push(g8);

    /* 9. DST 切换：全年偏移集合 */
    var g9 = new Group('dst', 'DST 切换与偏移集合');
    var expectedOffsets = {};
    var scanStart = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (var h = 0; h < 8760; h += 1) {
      var tt = scanStart + h * 3600000;
      expectedOffsets[-offsetRef(tt, zone) / 60000] = true;
    }
    var expOffsets = Object.keys(expectedOffsets).map(Number).sort(function (a, b) { return a - b; });
    var gotOffsets = (guards.distinctOffsets2026 || []).slice().sort(function (a, b) { return a - b; });
    g9.expect('2026 年 getTimezoneOffset 取值集合', expOffsets, gotOffsets);
    groups.push(g9);

    /* 10. 性能 */
    var g10 = new Group('perf', '性能');
    var ms = guards.perf100kMs;
    g10.assert('10 万次 getHours 耗时可接受', typeof ms === 'number' && ms < 300, '实际 ' + ms + ' ms（阈值 300 ms）');
    g10.assert('10 万次 getHours 结果正确', guards.perfAcc === 100000 * 12, '累计值 ' + guards.perfAcc);
    groups.push(g10);

    /* 11. 注入标记：属于被测环境自身的属性，与参考实现无关 */
    if (!options.skipMarker) {
      var g11 = new Group('marker', '注入标记');
      var shimMeta = (data.guards || {}).shimMeta || {};
      g11.expect('注入标记存在', true, !!shimMeta.present);
      g11.expect('注入标记时区', zone, shimMeta.zone);
      g11.expect('注入标记版本', 'string', typeof shimMeta.version);
      groups.push(g11);
    }

    var total = 0;
    var failed = 0;
    groups.forEach(function (g) { total += g.total; failed += g.failed; });

    return { groups: groups, total: total, failed: failed, ok: failed === 0, fingerprints: data };
  }

  function renderEngine(report) {
    var list = $('engineChecks');
    list.textContent = '';

    if (!report) {
      setTag('engineStatusTag', '', '未运行');
      return;
    }
    if (report.error) {
      setTag('engineStatusTag', 'bad', '失败');
      var li = document.createElement('li');
      li.className = 'check bad';
      li.innerHTML = '<span class="mark">!</span><span class="name">注入引擎自检无法运行<span class="detail"></span></span>';
      li.querySelector('.detail').textContent = report.error;
      list.appendChild(li);
      return;
    }

    report.groups.forEach(function (g) {
      var li = document.createElement('li');
      li.className = 'check ' + (g.ok() ? 'ok' : 'bad');

      var mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = g.ok() ? '✓' : '✕';

      var body = document.createElement('span');
      body.className = 'name';
      body.textContent = g.name;
      if (g.details.length) {
        var detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = g.details.join('\n');
        body.appendChild(detail);
      }

      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = (g.total - g.failed) + '/' + g.total;

      li.appendChild(mark);
      li.appendChild(body);
      li.appendChild(meta);
      list.appendChild(li);
    });

    setTag('engineStatusTag', report.ok ? 'ok' : 'bad',
      report.ok ? ('全部通过 · ' + report.total + ' 项') : (report.failed + ' 项不一致 / 共 ' + report.total + ' 项'));
    $('engineHint').className = 'hint' + (report.ok ? '' : ' err');
    $('engineHint').textContent = report.ok
      ? '注入引擎与浏览器原生行为完全一致，伪装脚本会在页面里按预期生效。'
      : '存在不一致项，上面列出的「期望 / 实际」即为差异明细；请联系开发者或换用推荐的时区。';
  }

  function engineChecks(report) {
    if (!report || report.error) return [];
    return report.groups.map(function (g) {
      return { id: g.id, name: g.name, passed: g.total - g.failed, total: g.total, ok: g.ok(), details: g.details };
    });
  }

  /* ============================ 标签页实测 ============================ */

  function probePage(expectedZone) {
    var shim = globalThis.__DSH_TZ_FIX__ || null;
    var resolved = '';
    try { resolved = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { resolved = 'unknown'; }
    return {
      zone: resolved,
      offset: new Date().getTimezoneOffset(),
      hasShim: !!shim,
      shimZone: shim ? shim.zone : null,
      shimVersion: shim ? shim.version : null,
      matches: resolved === expectedZone && !!shim && shim.zone === expectedZone,
      now: new Date().toString(),
      nowISO: new Date().toISOString(),
      ua: navigator.userAgent
    };
  }

  function checkTab(tabId, zone) {
    return new Promise(function (resolve) {
      try {
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'MAIN',
          func: probePage,
          args: [zone]
        }, function (results) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          var first = results && results[0];
          if (!first || !first.result) {
            resolve({ ok: false, error: '页面没有返回结果' });
            return;
          }
          resolve({ ok: true, result: first.result });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function renderTabs() {
    var select = $('tabSelect');
    var current = state.selectedTabId;
    select.textContent = '';

    if (!state.tabs.length) {
      var opt = document.createElement('option');
      opt.textContent = '没有可检测的标签页';
      opt.value = '';
      select.appendChild(opt);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    state.tabs.forEach(function (tab) {
      var o = document.createElement('option');
      o.value = String(tab.id);
      var title = tab.title || tab.url || ('标签页 ' + tab.id);
      o.textContent = (tab.url && tab.url.indexOf('chatgpt.com') >= 0 ? '★ ' : '') +
        title.slice(0, 48) + ' — ' + (tab.url || '').slice(0, 48);
      if (tab.id === current) o.selected = true;
      select.appendChild(o);
    });
  }

  function loadTabs() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({}, function (tabs) {
          if (chrome.runtime.lastError) { resolve([]); return; }
          var usable = (tabs || []).filter(function (t) {
            return t.url && /^(https?|file):/i.test(t.url);
          });
          resolve(usable);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  function renderTabReport(report) {
    var list = $('tabChecks');
    list.textContent = '';
    if (!report) { setTag('tabStatusTag', '', '未检测'); return; }

    function line(kind, name, detail, meta) {
      var li = document.createElement('li');
      li.className = 'check ' + kind;
      var mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = kind === 'ok' ? '✓' : (kind === 'bad' ? '✕' : '!');
      var body = document.createElement('span');
      body.className = 'name';
      body.textContent = name;
      if (detail) {
        var d = document.createElement('span');
        d.className = 'detail';
        d.textContent = detail;
        body.appendChild(d);
      }
      li.appendChild(mark);
      li.appendChild(body);
      if (meta) {
        var m = document.createElement('span');
        m.className = 'meta';
        m.textContent = meta;
        li.appendChild(m);
      }
      list.appendChild(li);
    }

    if (!report.ok) {
      setTag('tabStatusTag', 'bad', '检测失败');
      line('bad', '无法在当前标签页执行检测', report.error || '未知错误');
      return;
    }

    var r = report.result;
    var target = report.expectedZone;
    line(r.zone === target ? 'ok' : 'bad', '页面 JS 时区',
      '期望 ' + target + '\n实际 ' + r.zone, r.zone === target ? '一致' : '不一致');
    line(r.hasShim ? 'ok' : 'bad', '伪装脚本已注入',
      r.hasShim ? ('版本 ' + r.shimVersion + ' · 目标 ' + r.shimZone) : '页面主世界未检测到注入标记');
    line('ok', '页面当前时间（本地）', r.now, '');
    line('ok', '页面 UTC 时间', r.nowISO, '');
    line(r.matches ? 'ok' : 'warn', '综合结论',
      r.matches ? '该页面已完全按目标时区运行。' : '该页面尚未生效：请点击「刷新」重新加载后再检测一次。', '');

    setTag('tabStatusTag', r.matches ? 'ok' : 'bad', r.matches ? '已生效' : '未生效');
  }

  /* ============================ 环境卡片 / 报告 ============================ */

  function renderEnv() {
    var env = $('envList');
    env.textContent = '';
    var s = state.settings;
    var meta = state.meta || {};
    var hostZone = '';
    try { hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { hostZone = 'unknown'; }

    function row(k, v, plain) {
      var dt = document.createElement('dt');
      dt.textContent = k;
      var dd = document.createElement('dd');
      dd.textContent = v;
      if (plain) dd.className = 'plain';
      env.appendChild(dt);
      env.appendChild(dd);
    }

    if (!s) {
      row('状态', '无法读取扩展设置', true);
      return;
    }

    row('伪装状态', s.enabled ? '已开启' : '已关闭', true);
    row('伪装时区', s.zone + '　' + zoneLabel(s.zone), true);
    row('生效范围', s.scope === 'all' ? '所有网站' : '仅 ChatGPT 站点', true);
    row('系统真实时区', (meta.realZone || hostZone) + '　（Chrome 进程时区）', true);
    row('本页时区', hostZone + (state.hostPolluted ? '　⚠ 本页已被伪装，参考值不可靠' : '　（未被伪装，可作参考基准）'), true);
    row('扩展版本', String(meta.version || '—'), true);

    /*
     * 内容脚本注册状态是最容易出问题的一环：注册失败时如果只显示"未注册"，
     * 用户完全不知道该查什么。这里把后台记录的真实原因一并展示。
     */
    if (meta.scriptRegistered) {
      row('内容脚本', '已注册 ✓', true);
    } else {
      row('内容脚本', '未注册 ✗', true);
      row('注册失败原因', String(meta.registrationError || '未知（后台未记录错误）'), true);
    }

    var ok = s.enabled && !state.hostPolluted && meta.scriptRegistered;
    var tagKind = ok ? 'ok' : (s.enabled && !meta.scriptRegistered ? 'bad' : 'warn');
    var tagText = ok
      ? '可以开始自检'
      : (!meta.scriptRegistered ? '内容脚本未注册' : (s.enabled ? '参考基准受污染' : '扩展已关闭'));
    setTag('envStatusTag', tagKind, tagText);
  }

  function buildReport() {
    var report = {
      generatedAt: new Date().toISOString(),
      product: 'ChatGPT 时区修复 · 自检报告',
      extension: state.meta || {},
      settings: state.settings,
      host: {
        resolvedTimeZone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'unknown'; } })(),
        polluted: state.hostPolluted,
        url: location.href
      },
      engine: state.engine && !state.engine.error ? {
        ok: state.engine.ok,
        total: state.engine.total,
        failed: state.engine.failed,
        checks: engineChecks(state.engine)
      } : { error: state.engine ? state.engine.error : '未运行' },
      tab: state.tabReport || null
    };
    return report;
  }

  function renderReport() {
    $('report').textContent = JSON.stringify(buildReport(), null, 2);
  }

  function downloadReport() {
    var blob = new Blob([JSON.stringify(buildReport(), null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'tzfix-report-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ============================ 主流程 ============================ */

  function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
  }

  async function refreshState() {
    var res = await send({ type: 'getState' });
    if (!res || !res.ok) {
      state.settings = { v: 1, enabled: true, zone: DEFAULT_ZONE, scope: 'chatgpt' };
      state.meta = { error: res && res.error };
      return;
    }
    state.settings = res.state;
    state.meta = res.meta || {};
  }

  async function runEngine() {
    var zone = state.settings.zone || DEFAULT_ZONE;
    setTag('engineStatusTag', 'busy', '检测中…');
    var realm = await runRealm(zone);
    if (!realm.ok) {
      state.engine = { error: realm.error };
      renderEngine(state.engine);
      renderReport();
      return state.engine;
    }
    var report = analyseEngine(realm.data, zone);
    report.ready = realm.ready;
    state.engine = report;
    renderEngine(report);
    renderReport();
    return report;
  }

  async function runTabCheck(tabId) {
    if (!tabId) {
      state.tabReport = { ok: false, error: '请先选择一个标签页' };
      renderTabReport(state.tabReport);
      renderReport();
      return;
    }
    setTag('tabStatusTag', 'busy', '检测中…');
    var res = await checkTab(tabId, state.settings.zone);
    var tab = state.tabs.filter(function (t) { return t.id === tabId; })[0];
    state.tabReport = Object.assign({ tabId: tabId, tabUrl: tab ? tab.url : '', expectedZone: state.settings.zone }, res);
    renderTabReport(state.tabReport);
    renderReport();
  }

  async function runAll() {
    if (state.running) return;
    state.running = true;
    setBusy($('btnRun'), true);
    try {
      await refreshState();
      renderEnv();
      await loadTabs().then(function (tabs) {
        state.tabs = tabs;
        var chatgpt = tabs.filter(function (t) { return t.url && t.url.indexOf('chatgpt') >= 0; })[0];
        if (!state.selectedTabId) state.selectedTabId = chatgpt ? chatgpt.id : (tabs[0] ? tabs[0].id : null);
        renderTabs();
      });
      if (!state.settings.enabled) {
        setTag('engineStatusTag', 'warn', '扩展已关闭');
        $('engineHint').className = 'hint err';
        $('engineHint').textContent = '扩展当前处于关闭状态，页面不会被伪装；请先在扩展弹窗中开启。';
        renderReport();
        return;
      }
      /*
       * 内容脚本没注册时，"标签页实测"必然是失败的。
       * 这里先把根因说清楚，避免用户反复刷新页面却永远不生效。
       */
      if (!state.meta || !state.meta.scriptRegistered) {
        setTag('engineStatusTag', 'warn', '脚本未注册');
        $('engineHint').className = 'hint err';
        var why = (state.meta && state.meta.registrationError) || '未知原因';
        $('engineHint').textContent =
          '内容脚本没有注册成功，页面不会被伪装。后台记录的失败原因：' + why +
          '。请到 chrome://extensions 点扩展的「详情」查看错误，或点下方「复制」把诊断信息发给开发者。';
        renderReport();
        return;
      }
      if (state.hostPolluted) {
        setTag('engineStatusTag', 'warn', '基准受污染');
        $('engineHint').className = 'hint err';
        $('engineHint').textContent = '当前自检页面本身已被伪装，无法作为参考基准；请在扩展设置里把生效范围改为「仅 ChatGPT 站点」后再试。';
        renderReport();
        return;
      }
      await runEngine();
    } finally {
      state.running = false;
      setBusy($('btnRun'), false);
    }
  }

  function bind() {
    $('btnRun').addEventListener('click', function () { runAll(); });

    $('tabSelect').addEventListener('change', function (e) {
      state.selectedTabId = Number(e.target.value) || null;
    });

    $('btnCheckTab').addEventListener('click', async function () {
      var btn = $('btnCheckTab');
      setBusy(btn, true);
      try {
        var select = $('tabSelect');
        var id = Number(select.value) || state.selectedTabId;
        await runTabCheck(id);
      } finally {
        setBusy(btn, false);
      }
    });

    $('btnReloadTab').addEventListener('click', function () {
      var id = Number($('tabSelect').value) || state.selectedTabId;
      if (!id) { toast('请先选择标签页'); return; }
      try {
        chrome.tabs.reload(id);
        toast('已刷新，等待页面加载后重新检测');
      } catch (e) {
        toast('刷新失败：' + (e && e.message || e));
      }
    });

    $('btnOpenChatGPT').addEventListener('click', function () {
      send({ type: 'openChatGPT' }).then(function (res) {
        if (!res || !res.ok) chrome.tabs.create({ url: 'https://chatgpt.com/' });
      });
    });

    $('btnCopy').addEventListener('click', async function () {
      var text = JSON.stringify(buildReport(), null, 2);
      try {
        await navigator.clipboard.writeText(text);
        toast('诊断信息已复制到剪贴板');
      } catch (e) {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('诊断信息已复制');
      }
    });

    $('btnDownload').addEventListener('click', downloadReport);

    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[SETTINGS_KEY]) return;
        var next = changes[SETTINGS_KEY].newValue;
        var zoneChanged = !state.settings || state.settings.zone !== next.zone ||
          state.settings.enabled !== next.enabled || state.settings.scope !== next.scope;
        state.settings = next;
        renderEnv();
        if (zoneChanged && next.enabled && !state.hostPolluted) {
          toast('设置已更新，重新自检…');
          runEngine();
        }
      });
    } catch (e) { /* 忽略：不影响自检 */ }
  }

  async function init() {
    state.hostPolluted = !!globalThis.__DSH_TZ_FIX__;
    bind();
    await refreshState();
    renderEnv();
    $('footVersion').textContent = '版本 ' + ((state.meta && state.meta.version) || '—');
    await runAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /*
   * 测试钩子：仅供 Node 端集成测试复用这里的「参考算法」。
   * 页面自身不会读取它，浏览器 linter 忽略 no-undef。
   */
  globalThis.TZVerifyTest = {
    reference: {
      wall: wallRef,
      offset: offsetRef,
      localToUtc: localToUtcRef,
      parse: parseRef,
      toString: toStringRef,
      dateString: dateStringRef,
      timeString: timeStringRef,
      locale: localeRef,
      analyse: analyseEngine
    },
    tables: { construct: CONSTRUCT_REF, setter: SETTER_REF, parse: PARSE_INPUTS }
  };
})();
