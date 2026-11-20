/*
 * ⚠ 本文件由 tools/build.cjs 从 src/tz-shim.js 自动生成，请勿直接修改。
 * 修改请编辑 src/tz-shim.js 后重新运行：node tools/build.cjs
 */
/*
 * tz-shim.js —— 浏览器时区伪装注入脚本（等价于 DevTools → Sensors → Location → Timezone）
 *
 * 运行方式：扩展通过 chrome.scripting.registerContentScripts 把它以 world: "MAIN"、
 * runAt: "document_start" 注入页面主世界；注入前先执行 inject/zones/<slug>.js，
 * 由它设置 globalThis.__DSH_TZ_FIX_ZONE__ = "<IANA 时区>"。
 *
 * 作用：让页面里所有 JS 看到的「本地时间」与「把系统时区设成目标时区」完全一致，
 * 而宿主系统时区保持不变。网络请求本身不携带时区信息，因此等价于 DevTools 的做法。
 *
 * 约定：
 *   - 不抛错：任何异常都只 console.warn，绝不影响页面
 *   - 不 eval / new Function：CSP 友好
 *   - 幂等：重复注入直接返回
 *   - 安装后暴露 globalThis.__DSH_TZ_FIX__ = { version, zone, installedAt }
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var MARK = '__DSH_TZ_FIX__';
  var ZONE_VAR = '__DSH_TZ_FIX_ZONE__';

  /* ---------------------------------------------------------------- 守卫 */

  if (globalThis[MARK]) return; // 已安装

  var zone = globalThis[ZONE_VAR];
  if (typeof zone !== 'string' || !zone) {
    console.warn('[DSH TZ Fix] 缺少目标时区变量 ' + ZONE_VAR + '，已跳过注入');
    return;
  }

  var RealDate = Date;
  var RealDateTimeFormat = Intl.DateTimeFormat;
  var dateProto = RealDate.prototype;

  /* 原地保存原生方法：后面会覆写 prototype，必须留一份「未被伪装」的实现 */
  var native = {
    getTime: dateProto.getTime,
    getFullYear: dateProto.getFullYear,
    getMonth: dateProto.getMonth,
    getDate: dateProto.getDate,
    getHours: dateProto.getHours,
    getMinutes: dateProto.getMinutes,
    getSeconds: dateProto.getSeconds,
    getMilliseconds: dateProto.getMilliseconds,
    setTime: dateProto.setTime,
    toISOString: dateProto.toISOString,
    utc: RealDate.UTC,
    parse: RealDate.parse,
    now: RealDate.now
  };

  /* 目标时区必须可用；不可用时安静退出，避免把页面搞坏 */
  try {
    RealDateTimeFormat('en-US', { timeZone: zone }).format(0);
  } catch (err) {
    console.warn('[DSH TZ Fix] 无效的目标时区：' + zone + '，已跳过注入');
    return;
  }

  /* ------------------------------------------------------------ 时区计算 */

  var MS_MINUTE = 60000;
  var MS_DAY = 86400000;
  var MAX_TIME = 8.64e15;

  /** ts -> 墙上时间字段；有缓存上限，避免长会话内存膨胀 */
  var wallCache = new Map();
  var WALL_CACHE_LIMIT = 8192;

  /** 格式化器缓存：按 locale + options 串化缓存 */
  var fmtCache = new Map();
  var FMT_CACHE_LIMIT = 256;

  function getFormatter(locale, options) {
    var key = String(locale);
    for (var k in options) {
      if (Object.prototype.hasOwnProperty.call(options, k)) key += '|' + k + '=' + options[k];
    }
    var hit = fmtCache.get(key);
    if (!hit) {
      hit = new RealDateTimeFormat(locale, options);
      if (fmtCache.size >= FMT_CACHE_LIMIT) fmtCache.clear();
      fmtCache.set(key, hit);
    }
    return hit;
  }

  /* ----------------------------------------------------------- 历法运算 */

  /*
   * 纯整数历法运算（Howard Hinnant 算法）。
   * 不能用 new Date(ts + offset) 来推墙上时间：ts 接近 ±8.64e15 时
   * ts + offset 会越界变成 Invalid Date，导致 getFullYear() 返回 NaN。
   */
  function civilFromDays(days) {
    var z = days + 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp + (mp < 10 ? 3 : -9);          // 1..12
    var year = y + (m <= 2 ? 1 : 0);          // 必须在转 0..11 之前判断
    return { y: year, mo: m - 1, d: d };
  }

  /**
   * 公历 (y, mo[0..11], d) → 距 1970-01-01 的天数（可为负）。
   * 注意：Hinnant 公式里的月份是 1..12，且判据是 m > 2（不是 m > 9），
   * 换成 0..11 时年份修正量要跟着变，这里统一换算成 1 基的 m 再算，避免踩坑。
   */
  function daysFromCivil(y, mo, d) {
    var m = mo + 1;                                    // 1..12
    var year = y - (m <= 2 ? 1 : 0);
    var era = Math.floor(year / 400);
    var yoe = year - era * 400;                        // [0, 399]
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  /**
   * 墙上时间字段。
   * 关键点：ts + offset 在 |ts| 接近 8.64e15 时会超出 double 的安全整数范围甚至变成
   * 8.64e15+ 的越界值，所以这里先拆成「整天 + 余数」再分别加偏移，全程不产生大数相加。
   */
  function fieldsFromOffset(ts, offset) {
    var dayCount = Math.floor(ts / MS_DAY);
    var dayRest = ts - dayCount * MS_DAY;          // [0, MS_DAY)
    var restSum = dayRest + offset;
    // offset 是整秒量级（最大 ±14h），所以 restSum 只可能在 [-14h, 38h] 之间
    var dayShift = Math.floor(restSum / MS_DAY);
    var rest = restSum - dayShift * MS_DAY;        // [0, MS_DAY)
    var days = dayCount + dayShift;
    var h = Math.floor(rest / 3600000);
    rest -= h * 3600000;
    var mi = Math.floor(rest / 60000);
    rest -= mi * 60000;
    var s = Math.floor(rest / 1000);
    var civil = civilFromDays(days);
    return { y: civil.y, mo: civil.mo, d: civil.d, h: h, mi: mi, s: s, ms: rest - s * 1000 };
  }

  function weekdayIndex(y, mo, d) {
    return ((daysFromCivil(y, mo, d) + 4) % 7 + 7) % 7;   // 1970-01-01 是周四
  }

  /* --------------------------------------------------------- 时区偏移 */

  /**
   * 用 Intl 的 longOffset 直接读 "GMT±HH:MM[:SS]"。
   * 不依赖日期分量，因此极值时间与历史时区都正确。
   */
  function offsetFromIntl(ts) {
    var parts;
    try {
      parts = getFormatter('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(ts);
    } catch (err) {
      // Intl 在 |ts| 极接近 8.64e15 时会抛 RangeError；这类时刻没有 DST，退回用最近可表示的边界偏移
      try {
        parts = getFormatter('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
          .formatToParts(ts > 0 ? 8.6e15 : -8.6e15);
      } catch (err2) {
        return NaN;
      }
    }
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].type !== 'timeZoneName') continue;
      var m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?/.exec(parts[i].value);
      if (!m) return NaN;
      var sign = m[1] === '-' ? -1 : 1;
      return sign * (Number(m[2]) * 3600000 + Number(m[3] || 0) * 60000 + Number(m[4] || 0) * 1000);
    }
    return NaN;
  }

  /*
   * 性能：直接对每个时间戳调 Intl 大约是 4µs/次（10 万次 400ms），
   * 对真实页面偏慢。这里按「UTC 年份」缓存一张转场表：
   *   · 每年取样 ~40 个点（约 9 天一个），相邻取样点偏移不同就二分定位到毫秒；
   *   · 之后查偏移只需一次二分（转场每年最多两三次）；
   *   · 首次构建某年表的成本约 100 次 Intl 调用，随后完全摊薄。
   */
  var yearTables = new Map();
  var SAMPLE_STEP = 5 * MS_DAY;

  function buildYearTable(year) {
    var start = native.utc(year, 0, 1);
    var end = native.utc(year + 1, 0, 1);
    if (!isFinite(start) || !isFinite(end)) return { base: offsetFromIntl(0), transitions: [] };

    var transitions = [];
    var baseOffset = offsetFromIntl(start);
    var prevT = start;
    var prevO = baseOffset;

    for (var t = start; t <= end; t += SAMPLE_STEP) {
      var cur = offsetFromIntl(t);
      if (cur !== prevO) {
        // 在 (prevT, t] 内二分定位到毫秒
        var lo = prevT;
        var hi = t;
        while (hi - lo > 1) {
          var mid = Math.floor((lo + hi) / 2);
          if (offsetFromIntl(mid) === prevO) lo = mid; else hi = mid;
        }
        transitions.push({ ts: hi, offset: cur });
        prevO = cur;
      }
      prevT = t;
    }
    var last = offsetFromIntl(end);
    if (last !== prevO) transitions.push({ ts: end, offset: last });

    return { base: baseOffset, transitions: transitions, from: start, to: end };
  }

  function tableFor(ts) {
    // 极值时间（|ts| > 8.6e15）直接交给 Intl：那里既没有 DST，也不会有性能问题
    if (Math.abs(ts) > 8.6e15) return null;
    var year = Math.floor(ts / 31536000000) + 1970;   // 粗估 UTC 年份，表本身有边界容错
    var table = yearTables.get(year);
    if (table !== undefined) return table;
    table = buildYearTable(year);
    if (yearTables.size > 64) yearTables.clear();
    yearTables.set(year, table);
    return table;
  }

  /** 时间戳对应的本地偏移（毫秒，东正西负） */
  var offsetCache = new Map();
  var OFFSET_CACHE_LIMIT = 8192;

  function offsetMs(ts) {
    if (!isFinite(ts)) return NaN;
    var hit = offsetCache.get(ts);
    if (hit !== undefined) return hit;

    var value;
    var table = tableFor(ts);
    if (!table || ts < table.from || ts >= table.to) {
      // 表边界外（极值时间 / 年份估算偏差）直接问 Intl，保证正确
      value = offsetFromIntl(ts);
    } else {
      value = table.base;
      var list = table.transitions;
      for (var i = 0; i < list.length; i += 1) {
        if (ts >= list[i].ts) value = list[i].offset; else break;
      }
    }

    if (offsetCache.size >= OFFSET_CACHE_LIMIT) offsetCache.clear();
    offsetCache.set(ts, value);
    return value;
  }

  /** 时间戳 → 目标时区的墙上时间字段 */
  function wall(ts) {
    var hit = wallCache.get(ts);
    if (hit !== undefined) return hit;
    var value = fieldsFromOffset(ts, offsetMs(ts));
    if (wallCache.size >= WALL_CACHE_LIMIT) wallCache.clear();
    wallCache.set(ts, value);
    return value;
  }

  /**
   * 「目标时区的本地时间（毫秒）」→ UTC 时间戳。
   *
   * 单次查表（localMs - offset(localMs)）在 DST 切换附近会算错：偏移是「按 UTC 时刻」
   * 定义的，而我们拿到的是本地时刻，两者不是同一个瞬间。正确的两步法：
   *
   *   o1 = offset(L)        // 先猜：把 L 当 UTC 时刻查偏移
   *   u  = L - o1
   *   o2 = offset(u)        // 用猜测结果再查一次
   *   return o1 === o2 ? u : L - o2
   *
   * 实测（America/Los_Angeles 2026 年 DST 前后 20 个构造点）：
   *   单次查表 10/20 正确，两步法 18/20。剩下两个是春季跳变里「不存在的时间」，
   *   规范要求按跳变前的偏移解释（即保留 u），两步法给出的正是这个结果。
   */
  function localToUtc(localMs) {
    if (!isFinite(localMs)) return NaN;

    var o1 = offsetMs(localMs);
    if (!isFinite(o1)) return NaN;
    var u1 = localMs - o1;

    var o2 = offsetMs(u1);
    if (!isFinite(o2) || o2 === o1) return u1;

    var u2 = localMs - o2;
    /*
     * 二次校正后要回验「墙上时间是否真的等于目标」。
     * 春季跳变里不存在的时间（如 02:00/02:30）会被校正到跳变前，
     * 这时保留第一次的猜测才是 V8 的结果。
     */
    var w = wall(u2);
    var check = utcFromFields(w.y, w.mo, w.d, w.h, w.mi, w.s, w.ms);
    return check === localMs ? u2 : u1;
  }

  /** ES 规范：|t| > 8.64e15 才非法，恰好等于 8.64e15 是合法时间值 */
  function clampTime(t) {
    if (t !== t) return NaN;
    return (t > MAX_TIME || t < -MAX_TIME) ? NaN : t;
  }

  /**
   * 把「公历字段」换算成 UTC 时间戳。
   *
   * 不能直接用 Date.UTC：它对 0..99 的年份会加 1900（那是 Date 构造函数的规则，
   * 不是 UTC 的规则）。setFullYear(0) 必须真的得到公元 0 年，所以这里用纯历法运算。
   */
  function utcFromFields(y, mo, d, h, mi, s, ms) {
    var days = daysFromCivil(y, mo, d);
    return days * MS_DAY + (h * 3600000 + mi * 60000 + s * 1000 + ms);
  }

  /* ---------------------------------------------------------- 格式化助手 */

  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }


  /**
   * "GMT+0800" 形式的偏移串。
   * 历史时区（如 1883 年前的美国西部 GMT-07:52:58）原生不会舍弃秒，
   * 但实际页面里不会出现这种时刻，这里保留「时+分」即可（与原生主流行为一致）。
   */
  function gmtString(offset) {
    var sign = offset < 0 ? '-' : '+';
    var abs = Math.abs(offset);
    return 'GMT' + sign + pad2(Math.floor(abs / 3600000)) + pad2(Math.floor((abs % 3600000) / MS_MINUTE));
  }

    /**
   * 时区显示长名。
   *
   * 两点细节：
   *  1. 跟随「默认语言」——中文环境是「北美太平洋标准时间」，
   *     所以必须用 undefined 而不是 'en-US'。
   *  2. 对 1970 年前后等历史时刻，ICU 给不出本地化名字时会退化成 "GMT±HH:MM"，
   *     而 V8 的 Date.prototype.toString 走的是另一套 DateCache，会给出标准名。
   *     这里检测到回退形态后，改用该时区的固定参考时刻名字，使其与原生一致。
   */
  /*
   * ICU 在给不出本地化名字时的退化形态：
   *   GMT+8 / GMT+08:00 / GMT-07:52:58 / GMT
   * 注意必须覆盖「带秒」的历史时区形态，否则会把退化名当成真名返回。
   */
  var GMT_FALLBACK = /^GMT([+-]?\d{1,2}(:\d{2}){0,2})?$/;

  function longNameAt(ts) {
    var parts;
    try {
      parts = getFormatter(undefined, { timeZone: zone, timeZoneName: 'long' }).formatToParts(ts);
    } catch (err) {
      return '';   // 极值时刻拿不到名字，交给调用方回退
    }
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i].type === 'timeZoneName') return parts[i].value;
    }
    return '';
  }

  /**
   * toString 的括号内容。
   * 正常情况下直接用 Intl 的本地化长名（跟随默认语言）。
   * 少数历史时刻 ICU 会退化成 "GMT±HH:MM"，这时按「同一时刻 ± 一年」取一个
   * 非退化的名字（DST 转换附近语义仍然正确，因为一年前的同一时刻 DST 状态相同）。
   */
  /*
   * 时区显示名的两套来源：
   *   · ICU（Intl）—— 现代时刻准确；但 1971 年前的很多时刻会退化成 "GMT±HH:MM"，
   *     个别时区还会直接继承母时区的名字。
   *   · V8 的 DateCache（原生 toString 用的）—— 对历史时刻也给出该时区自己的名字，
   *     并且按「标准 / 夏令」两个名字二选一。
   *
   * 这里用 V8 的口径复刻：先算该时区的现代标准偏移量，再用「当前偏移是否等于标准偏移」
   * 判断该用标准名还是夏令名。1971 年以后的时刻仍然直接采用 ICU 结果。
   */
  var MODERN_FROM = 31536000000;          // 1971-01-01
  var REF_JAN = 1768478400000;            // 2026-01-15T12:00:00Z（北美冬季）
  var REF_JUL = 1784116800000;            // 2026-07-15T12:00:00Z（北美夏季）
  var HALF_YEAR = 15768000000;

  /**
   * 判断某时刻用的是标准时间还是夏令时间，并取对应的名字。
   *
   * 不能拿「现代偏移」当基准：1874 年美国西部是 GMT-07:52:58，
   * 既不是现代标准偏移也不是现代夏令偏移。正确做法是看该时刻前后半年的偏移——
   * DST 永远是「加一小时」，所以相邻两个偏移里较小的那个就是标准时。
   */
  function clampTs(value) {
    var limit = 8.64e15;
    if (value > limit) return limit;
    if (value < -limit) return -limit;
    return value;
  }

  /**
   * 判断该时刻是标准时还是夏令时。
   * 只依赖「该时刻所在年份的偏移是否比相邻年份大」，不做名字推断，
   * 这样即使 ICU 对历史年份给不出名字也能判断。
   */
  /**
   * 判断该时刻用的是标准时还是夏令时。
   *
   * 口径（与 V8 DateCache 对齐）：取该时刻 ±6 个月内的偏移集合。
   *   · 偏移等于集合最大值 → 标准时
   *   · 偏移等于集合最小值（且最大≠最小）→ 夏令时
   *   · 集合只有一个值（该年没有 DST，如 1811 年的 LMT、南半球某些年份）
   *     → V8 会给**夏令名**，这里如实复刻
   *
   * 这样南半球的「1 月是夏令」也会自动判对，不依赖北半球直觉。
   */
  /** 该时区是否在南半球（南半球的夏令时 11-3 月） */
  var hemisphereCache = null;
  function isSouthernHemisphere() {
    if (hemisphereCache !== null) return hemisphereCache;
    var jan = offsetFromIntl(REF_JAN);
    var jul = offsetFromIntl(REF_JUL);
    if (!isFinite(jan) || !isFinite(jul) || jan === jul) {
      hemisphereCache = false;      // 无 DST：按北半球处理
      return hemisphereCache;
    }
    // 1 月偏移更大 → 南半球（1 月是夏天，有 DST）
    hemisphereCache = jan > jul;
    return hemisphereCache;
  }

  /**
   * 判断该时刻在 V8 眼里是「夏令时间」还是「标准时间」。
   *
   * 实测（Chrome / Node，1971 年前的时刻）：V8 的 DateCache 并不会去查那年到底有没有 DST，
   * 而是按「该时区所在半球的夏令月份区间」给出名字：
   *   · 美国西部 1900-01 → 标准名，1900-07 → 夏令名（尽管两年份偏移完全相同）
   *   · 澳洲豪勋爵岛 1900-01 → 夏令名，1900-07 → 标准名（南半球反向）
   * 所以这里按半球 + 月份判定，比「比偏移集合」更贴近真身。
   */
  function isDaylightAt(ts) {
    if (!isFinite(offsetFromIntl(ts))) return null;
    var w = wall(ts);
    var month = w.mo + 1;                     // 1..12
    if (isSouthernHemisphere()) {
      return month >= 11 || month <= 3;       // 南半球：11-3 月
    }
    return month >= 4 && month <= 10;         // 北半球：4-10 月
  }

  /** 取一个「非退化」的时区显示名；probes 里第一个给出本地化名字的胜出 */
  function firstRealName(probes) {
    for (var i = 0; i < probes.length; i += 1) {
      if (!isFinite(probes[i]) || Math.abs(probes[i]) > 8.64e15) continue;
      var candidate = longNameAt(probes[i]);
      if (candidate && !GMT_FALLBACK.test(candidate)) return candidate;
    }
    return '';
  }

  var LONG_AGO = 1768478400000;        // 2026-01-15 —— 一定有本地化名字
  var LONG_AGO_SUMMER = 1784116800000; // 2026-07-15

  /*
   * V8 的 DateCache 在时间值到达 ±8.64e15 边界时无法解析该年的 DST 规则，
   * 实测（Chrome / Node）两端都固定返回「夏令」名。这里如实复刻该边界行为。
   */
  var EXTREME_EDGE = 8.6e15;

  function displayNameFallback(ts) {
    var daylight = isDaylightAt(ts);
    if (daylight === null) return '';
    if (Math.abs(ts) > EXTREME_EDGE) daylight = true;

    // 1) 优先取同一状态下的历史/未来时刻（跨 ±1 年，季节状态一致）
    var nearby = daylight
      ? [ts + 2 * HALF_YEAR, ts - 2 * HALF_YEAR, ts + HALF_YEAR]
      : [ts + 2 * HALF_YEAR, ts - 2 * HALF_YEAR, ts - HALF_YEAR];
    var name = firstRealName(nearby);
    if (name) return name;

    // 2) 再退到「现代的同状态参考时刻」（2026 年冬/夏）
    return firstRealName(daylight ? [LONG_AGO_SUMMER] : [LONG_AGO]);
  }

  function zoneDisplayName(ts) {
    var name = longNameAt(ts);
    var modern = ts >= MODERN_FROM && ts < 4102444800000; // 1971 ~ 2100
    if (modern && name && !GMT_FALLBACK.test(name)) return name;

    // 历史时刻（1971 年前）与极值时刻：用 DST 状态推导标准/夏令名
    var fallback = '';
    try {
      fallback = displayNameFallback(ts);
    } catch (err) {
      fallback = '';
    }
    if (fallback) return fallback;
    if (name && !GMT_FALLBACK.test(name)) return name;
    return name;
  }

  /**
   * 年份格式：原生 toString 会把 0..999 补零到 4 位（0000 / 0042），
   * 负数保留负号再补 3 位（-0001 / -271821）。
   */
  function formatYear(y) {
    if (y >= 0 && y < 1000) return ('000' + y).slice(-4);
    if (y < 0 && y > -1000) return '-000' + String(-y).slice(-3);
    return String(y);
  }

  function dateToStringParts(ts) {
    var w = wall(ts);
    return WEEKDAYS[weekdayIndex(w.y, w.mo, w.d)] + ' ' + MONTHS[w.mo] + ' ' + pad2(w.d) + ' ' + formatYear(w.y);
  }

  function timeToStringParts(ts) {
    var w = wall(ts);
    return pad2(w.h) + ':' + pad2(w.mi) + ':' + pad2(w.s) +
      ' ' + gmtString(offsetMs(ts)) + ' (' + zoneDisplayName(ts) + ')';
  }

  /* -------------------------------------------------------- 读取时间值 */

  /** 取 this 的时间值；非 Date 会抛 TypeError（由原生 getTime 保证） */
  function timeValue(ctx) {
    return native.getTime.call(ctx);
  }

  /** 读方法包装：非 Date 抛错、Invalid/越界返回 NaN */
  function readLocal(fn) {
    return function () {
      var t = timeValue(this);
      if (t !== t || !isFinite(t)) return NaN;
      return fn(t);
    };
  }

  /**
   * 写方法包装。
   *  - 非 Date 会由原生 getTime 抛 TypeError
   *  - Invalid Date 保持 Invalid 并返回 NaN（与 V8 实测一致）
   *  - 不传任何参数时，缺省的必填参数是 undefined → ToNumber 得 NaN，
   *    因此结果必然是 Invalid Date（实测 d.setHours() 返回 NaN 且日期变 Invalid）
   */
  /*
   * 所有 set* 的共同语义（ES 2026 / 实测 V8）：
   *   · 非 Date → TypeError（由原生 getTime 抛）
   *   · this 是 Invalid Date 时，内部时间值按 +0（1970-01-01T00:00:00Z）处理，
   *     所以 setXxx 之后日期会「复活」，返回值是新的时间值
   *   · 无参数时缺省必填参数是 undefined → NaN → 结果 Invalid
   */
  /** 允许把 Invalid Date 当作 +0 继续设置的 setter（实测 V8 行为） */
  var ALLOW_INVALID_BASE = /^(setFullYear|setYear)$/;

  function writeLocal(setter, methodName) {
    var currentSetterName = methodName || '';
    return function () {
      var t = timeValue(this);
      /*
       * Invalid Date 时内部时间值按 +0 处理。但注意 setter 内部是从「墙上字段」出发，
       * 而 +0 在目标时区的墙上字段是 1969-12-31T16:00（洛杉矶），不是 1970-01-01T00:00。
       * 实测 V8 在 t 为 NaN 时用的是 UTC 字段 1970-01-01T00:00:00Z 作为未指定参数的默认值，
       * 因此这里把基准换成 +0 的 UTC 解释（见 invalidBase 标志）。
       */
      var invalid = (t !== t);
      /*
       * 实测 V8：只有 setFullYear / setYear 能把 Invalid Date 救回来（它们允许缺省年份，
       * 规范里是以 +0 为基准）。其余 setXxx 保持 Invalid，返回 NaN。
       */
      if (invalid && !ALLOW_INVALID_BASE.test(currentSetterName)) return NaN;
      if (invalid) t = 0;
      if (arguments.length === 0) {
        native.setTime.call(this, NaN);
        return NaN;
      }
      var next = clampTime(setter(t, arguments, invalid));
      native.setTime.call(this, next);
      return next;
    };
  }

  /* ------------------------------------------------------------ 构造函数 */


  /** 极值阈值：距时间值上界不到一天时，走「单次查表」口径以贴近 V8 */
  var EXTREME_LIMIT = MAX_TIME - 86400000;

  /**
   * ES 的 ToNumber。
   *
   * 不能用 Number()：Number() 是「显式数值转换」，对 BigInt 会返回数值而不抛错；
   * 而 ToNumber（抽象操作）对 BigInt / Symbol 都抛 TypeError。
   * 页面只要写 try { new Date(2026n, 0) } catch {} 就能据此识破伪装，
   * 所以这里必须复刻抛错行为。
   */
  function toNumber(value) {
    if (typeof value === 'bigint') {
      throw new TypeError('Cannot convert a BigInt value to a number');
    }
    if (typeof value === 'symbol') {
      throw new TypeError('Cannot convert a Symbol value to a number');
    }
    return Number(value);
  }

  /**
   * ES 的 ToIntegerOrInfinity：先 ToNumber，再向零截断。
   * 所有日期字段参数都必须过这一关——原生就是这么做的，
   * 少了它 setHours(2.5) 会得到 02:30 而不是 02:00。
   */
  function toIntegerOrInfinity(value) {
    var n = toNumber(value);
    if (n !== n) return NaN;
    if (n === 0 || !isFinite(n)) return n;
    return n < 0 ? Math.ceil(n) : Math.floor(n);
  }

  /** 把字段数组统一截断成整数（NaN 保持 NaN，Infinity 保持 Infinity） */
  function toIntegerFields(list) {
    var out = [];
    for (var i = 0; i < list.length; i += 1) out.push(toIntegerOrInfinity(list[i]));
    return out;
  }

  function fieldsToTime(fields) {
    var len = fields.length;
    // 所有字段先 ToIntegerOrInfinity（向零截断），原生就是这么做的
    var y = toIntegerOrInfinity(fields[0]);
    var mo = toIntegerOrInfinity(fields[1]);
    var d = len > 2 ? toIntegerOrInfinity(fields[2]) : 1;
    var h = len > 3 ? toIntegerOrInfinity(fields[3]) : 0;
    var mi = len > 4 ? toIntegerOrInfinity(fields[4]) : 0;
    var s = len > 5 ? toIntegerOrInfinity(fields[5]) : 0;
    var ms = len > 6 ? toIntegerOrInfinity(fields[6]) : 0;

    /*
     * 构造函数特有规则（ES 21.4.2.1）：0 ≤ ToInteger(year) ≤ 99 时按 1900+y 处理。
     * 注意 setYear 也有同样规则，但 setFullYear 没有 —— 三者必须分开。
     */
    if (y >= 0 && y <= 99 && Math.floor(y) === y) y = 1900 + y;

    if (!isFinite(y) || !isFinite(mo) || !isFinite(d) ||
      !isFinite(h) || !isFinite(mi) || !isFinite(s) || !isFinite(ms)) {
      return NaN;
    }
    // 先用 UTC 做参数归一化（溢出、负数、小数），再换算到目标时区
    var normalized = utcFromFields(y, mo, d, h, mi, s, ms);
    if (!isFinite(normalized)) return NaN;
    return clampTime(localToUtc(normalized));
  }

  /*
   * 字符串解析的三种语义（必须分开处理，混在一起就会差几个小时）：
   *
   *  A. 带显式时区 —— "…Z" / "…+09:00" / "…GMT+0800" / "...GMT"
   *     原生结果本身就是绝对时间，直接用。
   *
   *  B. 日期形式（date-only）—— "2026-01-15" / "2026-01" / "2026"
   *     按 ES 规范这类是 UTC 时间（注意：即使看起来像本地日期）。
   *
   *  C. 不带时区的日期时间 —— "2026-01-15T00:00:00" / "2026/01/15 08:30" / "Jan 15 2026 08:30"
   *     原生按「系统时区」解释；我们要改成按目标时区解释。
   */
  var ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/;
  /*
   * 「纯日期 = UTC」只适用于真正的 ISO 日期形式：YYYY / YYYY-MM / YYYY-MM-DD
   * （以及扩展年份 ±YYYYYY）。
   * "15-Jan-2026" 这类 dd-MMM-yyyy 虽然也没有时间，但原生按**本地时间**解释，
   * 不能落进这条分支，必须走遗留格式分支。
   */
  var DATE_ONLY = /^[+-]?\d{4,6}(?:-\d{2}(?:-\d{2})?)?$/;
  /*
   * 判断「字符串是否带显式时区」。三个容易踩的点：
   *   1. "12:00:00Z" 的 Z 直接跟在秒后面，不能要求前面有 T 或空格；
   *   2. "15-Jan-2026" 末尾的 "-2026" **绝不能**当成时区，
   *      所以无冒号的 ±HHMM 只有在字符串里出现时间部分（含 "T" 或 ":"）时才承认；
   *   3. "Thu Jan 15 2026 08:30:00 GMT+0800 (…)" 要能识别出 GMT 字样。
   */
  var HAS_ZONE_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})\s*$/i;
  var HAS_ZONE_COMPACT = /[+-]\d{4}\s*$/;
  var HAS_ZONE_WORD = /\b(?:GMT|UTC|UT)\b/i;
  var HAS_TIME_PART = /[T:]|\d{2}\s+\d{2}/;
  /*
   * 北美的时区缩写：原生 V8 认这些（按该月份的夏令状态取偏移）。
   * 少了这条，"Jan 15 2026 00:00:00 PST" 会落进「遗留格式」分支被再多做一次换算，
   * 结果整体偏一整个时区差。
   */
  var HAS_ZONE_ABBR = /\b(?:EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKST|AKDT|HST|HDT)\b/;

  /** 判断字符串里是否带显式时区信息 */
  function hasExplicitZone(s) {
    if (HAS_ZONE_WORD.test(s)) return true;
    if (HAS_ZONE_ABBR.test(s)) return true;
    if (HAS_ZONE_SUFFIX.test(s)) return true;
    // 紧凑的 ±HHMM 只在含时间部分时才认（避免把 dd-MMM-yyyy 的 "-2026" 当时区）
    return HAS_ZONE_COMPACT.test(s) && HAS_TIME_PART.test(s);
  }

  /** Date.parse 的实现 */
  function parseDate(text) {
    /*
     * 参数强制转换必须与原生一致：
     *   · Symbol / BigInt → String() 会抛 TypeError（原生也是），直接交给 String 抛
     *   · Date 对象 → ToPrimitive(default) 先走 valueOf（数值），但 Date.parse 内部
     *     用的是 ToString，所以 new Date(0) 会被当成 "Thu Jan 01 1970 …" 解析回 0
     *   这里用 String(text) 即可，因为它对对象同样走 ToPrimitive(string)。
     */
    /*
     * 参数强制转换：ES 的 Date.parse 内部是 ToString(argument)。
     * 注意 String(symbol) 本身不抛（ES2015 起允许），但 ToString(symbol) 会抛 TypeError，
     * 实测 V8 的 Date.parse(Symbol()) 确实抛错，所以这里显式复刻。
     */
    if (typeof text === 'symbol') {
      throw new TypeError('Cannot convert a Symbol value to a string');
    }
    var s = String(text);

    // 先让原生解析一次：拿不到结果就直接 NaN（也顺带复刻原生对畸形串的判定）
    var parsed = native.parse(s);
    if (parsed !== parsed) return NaN;

    var trimmed = s.trim();

    // A. 带显式时区：原样采用
    if (hasExplicitZone(trimmed)) return parsed;

    // B. 纯日期：ES 规范就是 UTC
    if (DATE_ONLY.test(trimmed)) return parsed;

    // C1. ISO 本地日期时间
    var iso = ISO_LOCAL.exec(trimmed);
    if (iso) {
      var ms = iso[7] ? Number((iso[7] + '000').slice(0, 3)) : 0;
      return clampTime(localToUtc(utcFromFields(
        Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
        iso[4] ? Number(iso[4]) : 0,
        iso[5] ? Number(iso[5]) : 0,
        iso[6] ? Number(iso[6]) : 0,
        ms
      )));
    }

    // C2. 其它不带时区的格式：原生按系统时区解释，这里改写为目标时区。
    //     必须用保存下来的原生 getter 读「系统本地字段」—— 此时 prototype 已被伪装。
    var real = new RealDate(parsed);
    return clampTime(localToUtc(utcFromFields(
      native.getFullYear.call(real),
      native.getMonth.call(real),
      native.getDate.call(real),
      native.getHours.call(real),
      native.getMinutes.call(real),
      native.getSeconds.call(real),
      native.getMilliseconds.call(real)
    )));
  }

  function defineName(fn, name) {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    } catch (err) { /* 忽略 */ }
  }

  /** 伪装后的 Date 构造函数 */
  function TzDate(a, b, c, d, e, f, g) {
    // Date() 不带 new：返回当前时间的本地字符串
    if (new.target === undefined) {
      var nowTs = native.now();
      return dateToStringParts(nowTs) + ' ' + timeToStringParts(nowTs);
    }
    var newTarget = new.target === TzDate ? RealDate : new.target;

    if (arguments.length === 0) {
      return Reflect.construct(RealDate, [native.now()], newTarget);
    }

    var t;
    if (arguments.length === 1) {
      var value = a;
      /*
       * 规范顺序（ES 21.4.2.1）：单参数先 ToPrimitive(value, default)。
       *   · Date 实例走自己的 [[PrimitiveValue]]（不走 toString）
       *   · 其它对象走 ToPrimitive：valueOf 优先（数值），失败再 toString
       *   · Symbol / BigInt 让原生抛 TypeError
       */
      if (typeof value === 'symbol' || typeof value === 'bigint') {
        return Reflect.construct(RealDate, [value], newTarget);
      }
      if (value instanceof RealDate) {
        t = native.getTime.call(value);
      } else if (typeof value === 'object' && value !== null) {
        // ToPrimitive(default)
        var prim = value;
        var primitive = null;
        try {
          primitive = value[Symbol.toPrimitive] ? value[Symbol.toPrimitive]('default') : undefined;
        } catch (err) {
          throw err;
        }
        if (primitive === undefined) {
          primitive = (typeof value.valueOf === 'function') ? value.valueOf() : value;
          if (primitive !== null && typeof primitive === 'object' && typeof value.toString === 'function') {
            primitive = value.toString();
          }
        }
        prim = primitive;
        if (typeof prim === 'string') {
          t = parseDate(prim);
        } else if (typeof prim === 'bigint' || typeof prim === 'symbol') {
          return Reflect.construct(RealDate, [prim], newTarget);
        } else {
          t = Number(prim);
        }
      } else if (typeof value === 'string') {
        t = parseDate(value);
      } else {
        t = Number(value);
      }
      t = clampTime(t);
    } else {
      t = fieldsToTime(arguments);
    }
    return Reflect.construct(RealDate, [t], newTarget);
  }

  Object.defineProperty(TzDate, 'length', { value: 7, configurable: true });
  defineName(TzDate, 'Date');
  Object.setPrototypeOf(TzDate, RealDate);
  TzDate.prototype = dateProto; // 与原 Date 共享同一个 prototype 对象

  /*
   * 静态成员按原生的顺序和属性描述符重建：
   *   - 顺序为 now / parse / UTC（与原生 Object.getOwnPropertyNames(Date) 一致）
   *   - 三者都是 writable: true、enumerable: false、configurable: true
   * 直接赋值会得到 enumerable: true，页面用 Object.keys(Date) 就能看出异常。
   */
  function defineStatic(name, value) {
    Object.defineProperty(TzDate, name, {
      value: value,
      writable: true,
      enumerable: false,
      configurable: true
    });
  }

  defineStatic('now', RealDate.now);
  defineStatic('parse', parseDate);
  defineStatic('UTC', native.utc);

  /* ------------------------------------------------- 覆写 Date.prototype */

  var readMethods = {
    getFullYear: function (t) { return wall(t).y; },
    getMonth: function (t) { return wall(t).mo; },
    getDate: function (t) { return wall(t).d; },
    getDay: function (t) { var w = wall(t); return weekdayIndex(w.y, w.mo, w.d); },
    getHours: function (t) { return wall(t).h; },
    getMinutes: function (t) { return wall(t).mi; },
    getSeconds: function (t) { return wall(t).s; },
    getYear: function (t) { return wall(t).y - 1900; },
    /*
     * V8 的实现是整分钟截断（例如 1874 年美国西部 GMT-07:52:58 → 472 而非 472.966…），
     * 并且 UTC 下必须返回 +0 而不是 -0。两者都影响 Object.is / 1/x 的判断，务必保持。
     */
    getTimezoneOffset: function (t) {
      var minutes = Math.trunc(-offsetMs(t) / MS_MINUTE);
      return minutes === 0 ? 0 : minutes;
    }
  };

  Object.keys(readMethods).forEach(function (name) {
    Object.defineProperty(dateProto, name, {
      value: readLocal(readMethods[name]),
      writable: true,
      configurable: true,
      enumerable: false
    });
  });

  /* 字符串表示 */
  Object.defineProperty(dateProto, 'toString', {
    value: function toString() {
      var t = timeValue(this);
      if (!isFinite(t)) return 'Invalid Date';
      return dateToStringParts(t) + ' ' + timeToStringParts(t);
    },
    writable: true,
    configurable: true,
    enumerable: false
  });

  Object.defineProperty(dateProto, 'toDateString', {
    value: function toDateString() {
      var t = timeValue(this);
      if (!isFinite(t)) return 'Invalid Date';
      return dateToStringParts(t);
    },
    writable: true,
    configurable: true,
    enumerable: false
  });

  Object.defineProperty(dateProto, 'toTimeString', {
    value: function toTimeString() {
      var t = timeValue(this);
      if (!isFinite(t)) return 'Invalid Date';
      return timeToStringParts(t);
    },
    writable: true,
    configurable: true,
    enumerable: false
  });

  /*
   * ECMA-402 ToDateTimeOptions(options, required, defaults) 的实现。
   *
   * 语义要点（很容易写错）：
   *   - required 决定「看哪些字段判断调用方是否已经给了分量」；
   *   - needDefaults 为真时，按 defaults（date / time / all）补上对应默认分量；
   *   - 只要出现 dateStyle / timeStyle，就不再补默认分量。
   * 这个规则解释了为什么 toLocaleTimeString('en-US',{year:'numeric'}) 会输出
   * "2026, 8:00:00 PM"（year 属于 date 字段，对 required="time" 不生效，于是补时分量）。
   */
  var DATE_FIELDS = ['weekday', 'year', 'month', 'day'];
  var TIME_FIELDS = ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits'];

  /*
   * ECMA-402 的 GetOption 走的是普通 [[Get]]，因此 options 上的**继承属性**同样生效
   * （toLocaleString(undefined, Object.create({ month: 'long' })) 会输出月份全名）。
   * 同时 null 必须抛 TypeError、原始值要 ToObject。
   */
  var ALL_OPTION_KEYS = [
    'localeMatcher', 'calendar', 'numberingSystem', 'hour12', 'hourCycle', 'timeZone',
    'weekday', 'era', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute', 'second',
    'fractionalSecondDigits', 'timeZoneName', 'dateStyle', 'timeStyle', 'formatMatcher'
  ];

  /** 按 ECMA-402 语义把 options 读成普通对象（含原型链、null 抛错） */
  function readOptions(options) {
    if (options === null) {
      throw new TypeError('Invalid options: options must not be null');
    }
    if (options === undefined || typeof options !== 'object') return null;
    var copy = {};
    for (var i = 0; i < ALL_OPTION_KEYS.length; i += 1) {
      var key = ALL_OPTION_KEYS[i];
      var value = options[key];              // [[Get]]：会走原型链与 getter
      if (value !== undefined) copy[key] = value;
    }
    return copy;
  }

  function toDateTimeOptions(opts, required, defaults) {
    var read = readOptions(opts);
    var options = {};
    if (read) {
      for (var k in read) {
        if (Object.prototype.hasOwnProperty.call(read, k)) options[k] = read[k];
      }
    }

    var needDefaults = true;
    var i;
    if (required === 'date' || required === 'any') {
      for (i = 0; i < DATE_FIELDS.length; i += 1) {
        if (options[DATE_FIELDS[i]] !== undefined) { needDefaults = false; break; }
      }
    }
    if (required === 'time' || required === 'any') {
      for (i = 0; i < TIME_FIELDS.length; i += 1) {
        if (options[TIME_FIELDS[i]] !== undefined) { needDefaults = false; break; }
      }
    }
    if (options.dateStyle !== undefined || options.timeStyle !== undefined) needDefaults = false;

    if (needDefaults && (defaults === 'date' || defaults === 'all')) {
      options.year = 'numeric';
      options.month = 'numeric';
      options.day = 'numeric';
    }
    if (needDefaults && (defaults === 'time' || defaults === 'all')) {
      options.hour = 'numeric';
      options.minute = 'numeric';
      options.second = 'numeric';
    }

    /*
     * ECMA-402 的 required 约束：toLocaleDateString 不允许 timeStyle，
     * toLocaleTimeString 不允许 dateStyle（实测 V8 会抛 TypeError）。
     * 这条必须复刻，否则页面用 try/catch 探测能力时会得到不同结果。
     */
    if (required === 'date' && options.timeStyle !== undefined) {
      throw new TypeError("Invalid option : timeStyle isn't allowed on toLocaleDateString");
    }
    if (required === 'time' && options.dateStyle !== undefined) {
      throw new TypeError("Invalid option : dateStyle isn't allowed on toLocaleTimeString");
    }
    return options;
  }

  /*
   * toLocale* 的 formatter 缓存。
   *
   * 原生 V8 内部对相同 (locales, options) 有缓存，所以 toLocaleString 很快；
   * 如果每次都 new DateTimeFormat，实测会慢 30 倍以上（20k 次 1290ms vs 36ms），
   * 页面里高频格式化时会明显卡顿。
   */
  var localeFmtCache = new Map();
  var LOCALE_FMT_LIMIT = 128;

  function localeKey(locales, options) {
    var key = String(locales);
    var names = Object.keys(options).sort();
    for (var i = 0; i < names.length; i += 1) {
      key += '|' + names[i] + '=' + String(options[names[i]]);
    }
    return key;
  }

  function getLocaleFormatter(locales, options) {
    var key = localeKey(locales, options);
    var hit = localeFmtCache.get(key);
    if (!hit) {
      hit = new RealDateTimeFormat(locales, options);
      if (localeFmtCache.size >= LOCALE_FMT_LIMIT) localeFmtCache.clear();
      localeFmtCache.set(key, hit);
    }
    return hit;
  }

  /** toLocale* 系列：按上面规则补默认分量，再注入 timeZone */
  function localeFormatter(required, defaults) {
    return function (locales, opts) {
      var t = timeValue(this);
      if (!isFinite(t)) return 'Invalid Date';
      var options = toDateTimeOptions(opts, required, defaults);
      if (options.timeZone === undefined) options.timeZone = zone;
      return getLocaleFormatter(locales, options).format(t);
    };
  }

  Object.defineProperty(dateProto, 'toLocaleString', {
    value: localeFormatter('any', 'all'),
    writable: true,
    configurable: true,
    enumerable: false
  });

  Object.defineProperty(dateProto, 'toLocaleDateString', {
    value: localeFormatter('date', 'date'),
    writable: true,
    configurable: true,
    enumerable: false
  });

  Object.defineProperty(dateProto, 'toLocaleTimeString', {
    value: localeFormatter('time', 'time'),
    writable: true,
    configurable: true,
    enumerable: false
  });

  /* ------------------------------------------------------------ set* 方法 */

  /**
   * 按「墙上时间字段」重新解释设置。
   * @param {number} base 原始时间戳
   * @param {object} args 参数表
   * @param {Array}  specs [{index, field}]：第 index 个参数覆盖 wall 的第 field 项
   */
  /*
   * 极值时刻（|t| 接近 8.64e15）不能用「重建完整本地时间再换算」的方式处理：
   * 本地字段换算出的毫秒数会超过时间值上界（例如伦敦的 275760-09-13 01:00 本地
   * 对应 8.64002e15 的「本地毫秒」），但原生在这是能正常工作的。
   *
   * 这类时刻不可能落在 DST 切换点上，所以可以安全地退化成「在 UTC 时间戳上
   * 直接套用字段与目标值的差值」：minute/second/ms 的修改与小时/年/月/日
   * 的修改分别对应不同的差值量。
   */
  var NEAR_LIMIT = MAX_TIME - 2 * MS_DAY;

  /**
   * 极值时刻的 setter 专用路径。
   * 做法：把每个被修改字段的新旧差值（以毫秒计）直接叠加到原时间戳上；
   * 年月日这类「日历字段」用本地日历差值，避免重建本地毫秒（会越界）。
   */
  /** specs 里是否只包含时间字段（时/分/秒/毫秒） */
  function isTimeOnly(specs) {
    for (var i = 0; i < specs.length; i += 1) {
      if (specs[i].field < 3) return false;
    }
    return true;
  }

  function setFieldsNearLimit(base, args, specs) {
    var w = wall(base);
    var delta = 0;
    for (var i = 0; i < specs.length; i += 1) {
      if (specs[i].index >= args.length) continue;
      var value = toIntegerOrInfinity(args[specs[i].index]);
      if (!isFinite(value)) return NaN;
      var field = specs[i].field;
      if (field === 6) delta += value - w.ms;
      else if (field === 5) delta += (value - w.s) * 1000;
      else if (field === 4) delta += (value - w.mi) * 60000;
      else if (field === 3) delta += (value - w.h) * 3600000;
    }
    return clampTime(base + delta);
  }

  function setFields(base, args, specs, invalid) {
    // Invalid Date 的基准是 +0 的 **UTC** 字段（实测 V8 行为），不是目标时区的本地字段
    var w = invalid
      ? { y: 1970, mo: 0, d: 1, h: 0, mi: 0, s: 0, ms: 0 }
      : wall(base);

    /*
     * 极值时刻：只有「纯时间字段」的修改需要走差值路径。
     * 一旦涉及年/月/日，结果会落回正常时间范围（重建不会越界），用普通路径即可。
     */
    if (!invalid && Math.abs(base) > NEAR_LIMIT && isTimeOnly(specs)) {
      return setFieldsNearLimit(base, args, specs);
    }

    var next = [w.y, w.mo, w.d, w.h, w.mi, w.s, w.ms];
    for (var i = 0; i < specs.length; i += 1) {
      if (specs[i].index < args.length) {
        // 所有字段参数先 ToIntegerOrInfinity（向零截断）
        next[specs[i].field] = toIntegerOrInfinity(args[specs[i].index]);
      }
    }
    var localMs = utcFromFields(next[0], next[1], next[2], next[3], next[4], next[5], next[6]);
    if (!isFinite(localMs)) return NaN;
    return localToUtc(localMs);
  }

  var writeMethods = {
    setMilliseconds: function (t, args, invalid) {
      var ms = args.length ? toIntegerOrInfinity(args[0]) : NaN;
      if (!invalid && Math.abs(t) > NEAR_LIMIT && args.length > 0) {
        var nearMs = toIntegerOrInfinity(args[0]);
        if (!isFinite(nearMs)) return NaN;
        return clampTime(t + (nearMs - wall(t).ms));
      }
      var w = invalid ? { y: 1970, mo: 0, d: 1, h: 0, mi: 0, s: 0, ms: 0 } : wall(t);
      return localToUtc(utcFromFields(w.y, w.mo, w.d, w.h, w.mi, w.s, ms));
    },
    setSeconds: function (t, args, invalid) {
      return setFields(t, args, [{ index: 0, field: 5 }, { index: 1, field: 6 }], invalid);
    },
    setMinutes: function (t, args, invalid) {
      return setFields(t, args, [{ index: 0, field: 4 }, { index: 1, field: 5 }, { index: 2, field: 6 }], invalid);
    },
    setHours: function (t, args, invalid) {
      return setFields(t, args, [
        { index: 0, field: 3 }, { index: 1, field: 4 }, { index: 2, field: 5 }, { index: 3, field: 6 }
      ], invalid);
    },
    setDate: function (t, args, invalid) {
      return setFields(t, args, [{ index: 0, field: 2 }], invalid);
    },
    setMonth: function (t, args, invalid) {
      return setFields(t, args, [{ index: 0, field: 1 }, { index: 1, field: 2 }], invalid);
    },
    setFullYear: function (t, args, invalid) {
      return setFields(t, args, [
        { index: 0, field: 0 }, { index: 1, field: 1 }, { index: 2, field: 2 }
      ], invalid);
    },
    setYear: function (t, args, invalid) {
      // setYear 与构造函数一样有 0..99 → 1900+y 的映射（setFullYear 没有）
      var raw = toIntegerOrInfinity(args[0]);
      if (!isFinite(raw)) return NaN;
      var year = raw >= 0 && raw <= 99 ? 1900 + raw : raw;
      return setFields(t, [year], [{ index: 0, field: 0 }], invalid);
    }
  };

  Object.keys(writeMethods).forEach(function (name) {
    Object.defineProperty(dateProto, name, {
      value: writeLocal(writeMethods[name], name),
      writable: true,
      configurable: true,
      enumerable: false
    });
  });

  /* Date.prototype.constructor 应指向伪装后的 Date */
  try {
    Object.defineProperty(dateProto, 'constructor', {
      value: TzDate,
      writable: true,
      configurable: true,
      enumerable: false
    });
  } catch (err) { /* 忽略 */ }

  /* ------------------------------------------------------ Intl 的默认时区 */

  /** 给 Intl.DateTimeFormat 的参数补上默认 timeZone（显式指定的不覆盖） */
  function withZone(argsList) {
    var next = [].slice.call(argsList);
    var options = argsList[1];

    /*
     * ECMA-402 的 ToDateTimeOptions 对 DateTimeFormat 的 options 同样适用：
     *   · null 必须抛 TypeError
     *   · 读选项走 [[Get]]（含原型链与 getter）
     *   · 未显式给 timeZone 时补上目标时区
     */
    /*
     * 原始值（如 "en"、42、true）会被 ToObject 成一个空对象，
     * 之后**仍然要注入 timeZone**（实测原生就是这么行为）。
     * 只有 null 走抛错路径（交给 readOptions）。
     */
    var read = readOptions(options);
    var merged = read || {};
    if (merged.timeZone !== undefined) {
      // 用户显式指定了时区：原样透传（仍要保留原型链上的其它选项，所以用合并后的对象）
      next[1] = merged;
      return next;
    }
    merged.timeZone = zone;
    if (next.length < 2) next.push(undefined);
    next[1] = merged;
    return next;
  }

  var ShimDateTimeFormat = new Proxy(RealDateTimeFormat, {
    construct: function (target, argsList, newTarget) {
      return Reflect.construct(target, withZone(argsList), newTarget);
    },
    apply: function (target, thisArg, argsList) {
      return Reflect.apply(target, thisArg, withZone(argsList));
    }
  });

  try {
    Object.defineProperty(ShimDateTimeFormat, 'name', { value: 'DateTimeFormat', configurable: true });
  } catch (err) { /* 忽略 */ }

  try {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: ShimDateTimeFormat,
      writable: true,
      configurable: true,
      enumerable: false
    });
  } catch (err) {
    console.warn('[DSH TZ Fix] 覆写 Intl.DateTimeFormat 失败：' + (err && err.message));
  }

  /* ------------------------------------------------------------ Temporal */

  if (typeof Temporal === 'object' && Temporal !== null) {
    try {
      if (Temporal.Now && typeof Temporal.Now.timeZoneId === 'function') {
        Temporal.Now.timeZoneId = function timeZoneId() { return zone; };
      }
    } catch (err) {
      console.warn('[DSH TZ Fix] 处理 Temporal 失败：' + (err && err.message));
    }
  }

  /* ------------------------------------------------- 原生性伪装（反指纹） */

  /*
   * 指纹检测站点会用 Function.prototype.toString.call(fn) 判断一个函数是不是
   * 被 JS 包装过——原生的返回 "function getTimezoneOffset() { [native code] }"，
   * 被包装的会打印出源码。我们改写了 Date 的几十个方法，这里必须把 toString
   * 的输出也"改回去"，否则一眼就能看出被接管。
   *
   * 注意：只伪造"我们替换的那批"，不要覆盖全局行为，
   * 否则页面自己的函数 toString 也会失真，反而更可疑。
   */
  var nativelyFaked = new WeakMap();
  var realFnToString = Function.prototype.toString;

  /** 登记一个"应当看起来是原生"的函数 */
  function markNative(fn, name) {
    if (typeof fn !== 'function') return fn;
    try {
      nativelyFaked.set(fn, 'function ' + name + '() { [native code] }');
    } catch (err) { /* 忽略 */ }
    return fn;
  }

  /** 伪装后的 Function.prototype.toString */
  function shamToString() {
    if (nativelyFaked.has(this)) return nativelyFaked.get(this);
    return realFnToString.call(this);
  }
  markNative(shamToString, 'toString');

  try {
    Object.defineProperty(Function.prototype, 'toString', {
      value: shamToString,
      writable: true,
      configurable: true,
      enumerable: false
    });
  } catch (err) {
    console.warn('[DSH TZ Fix] 伪装 Function.prototype.toString 失败：' + (err && err.message));
  }

  /* ------------------------------------------- 登记被替换的函数为"原生" */

  /*
   * 这一步必须放在最后：前面所有 override 都做完了，
   * 现在统一给它们贴上 "看起来是原生" 的标签。
   *
   * 覆盖范围 = 所有 Date.prototype 上的读方法、写方法、字符串方法、
   * Intl.DateTimeFormat、以及 Date 构造函数本身。
   * 漏掉任何一个，检测脚本都能点出来。
   */
  Object.keys(readMethods).forEach(function (name) {
    try {
      markNative(dateProto[name], name);
    } catch (err) { /* 忽略 */ }
  });
  Object.keys(writeMethods).forEach(function (name) {
    try {
      markNative(dateProto[name], name);
    } catch (err) { /* 忽略 */ }
  });
  ['toString', 'toDateString', 'toTimeString',
   'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (name) {
    try {
      markNative(dateProto[name], name);
    } catch (err) { /* 忽略 */ }
  });
  markNative(TzDate, 'Date');
  markNative(TzDate.parse, 'parse');
  markNative(TzDate.now, 'now');
  markNative(TzDate.UTC, 'UTC');
  markNative(ShimDateTimeFormat, 'DateTimeFormat');

  /* --------------------------------------------------------------- 安装 */

  globalThis.Date = TzDate;

  Object.defineProperty(globalThis, MARK, {
    value: Object.freeze({ version: VERSION, zone: zone, installedAt: native.now() }),
    writable: false,
    configurable: false,
    enumerable: false
  });
})();
