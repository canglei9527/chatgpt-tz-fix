/*
 * popup.js —— 时区修复扩展弹窗逻辑（MV3，无外部依赖）
 *
 * 职责：
 *  1. 展示当前状态、真实时区 / 伪装时区、双时钟对照
 *  2. 切换开关、选择时区、切换生效范围（写入 chrome.storage → background 重注册内容脚本）
 *  3. 检测当前标签页是否真的被伪装
 */
(function () {
  'use strict';

  /*
   * 默认值只在 background.js 的 FALLBACK_STATE 里定义一次，
   * 这里只保留一个「兜底」对象——仅当 getState 完全失败时才用，
   * 避免两处硬编码不同步（改了时区默认值却只改了一边）。
   */
  var FALLBACK_STATE = { v: 1, enabled: true, zone: 'America/Los_Angeles', scope: 'chatgpt' };
  var SEARCH_LIMIT = 60;

  var $ = function (id) { return document.getElementById(id); };

  var ui = {
    toggle: null,
    statusDot: null,
    statusText: null,
    realZone: null,
    maskZone: null,
    clockReal: null,
    clockMasked: null,
    clockDay: null,
    checkResult: null,
    zoneSearch: null,
    zoneSelect: null,
    savedHint: null,
    scopeSegment: null,
    webrtcToggle: null,
    fontToggle: null,
    proxyToggle: null,
    proxyPort: null,
    proxyHint: null,
    ipRow: null,
    ipValue: null,
    ipHint: null,
    btnDetectIp: null,
    btnCheck: null,
    btnReload: null,
    btnOpen: null,
    btnVerify: null,
    btnCopy: null,
    version: null,
    toast: null
  };

  var state = {
    settings: null,
    meta: null,
    zones: [],
    filtered: [],
    tickTimer: null,
    saveTimer: null,
    busy: false
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
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toast(text) {
    var el = ui.toast;
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }

  function flashSaved() {
    if (!ui.savedHint) return;
    ui.savedHint.classList.add('show');
    clearTimeout(flashSaved._timer);
    flashSaved._timer = setTimeout(function () { ui.savedHint.classList.remove('show'); }, 1600);
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('busy', busy);
  }

  function currentZoneEntry() {
    var zone = state.settings && state.settings.zone;
    for (var i = 0; i < state.zones.length; i += 1) {
      if (state.zones[i].zone === zone) return state.zones[i];
    }
    return null;
  }

  function zoneLabel(zone) {
    for (var i = 0; i < state.zones.length; i += 1) {
      if (state.zones[i].zone === zone) return state.zones[i].label || zone;
    }
    return zone;
  }

  /* ============================ 渲染 ============================ */

  function renderStatus() {
    var s = state.settings;
    if (!s) return;

    var enabled = s.enabled;
    var realZone = (state.meta && state.meta.realZone) || '—';

    ui.toggle.checked = enabled;
    ui.toggle.setAttribute('aria-checked', String(enabled));

    ui.statusDot.className = 'dot ' + (enabled ? 'on' : 'off');
    ui.statusText.textContent = enabled ? '已生效 · 页面时区会被伪装' : '已关闭 · 页面使用真实时区';

    ui.realZone.textContent = realZone;
    ui.maskZone.textContent = zoneLabel(s.zone);
    ui.maskZone.title = s.zone;

    if (ui.webrtcToggle) {
      ui.webrtcToggle.checked = !!s.webrtc;
    }
    if (ui.fontToggle) {
      ui.fontToggle.checked = !!s.font;
    }
    if (ui.proxyToggle) {
      ui.proxyToggle.checked = !!s.browserProxy;
    }
    if (ui.proxyPort) {
      ui.proxyPort.value = String(s.proxyPort || 7891);
      updateProxyHint(!!s.browserProxy);
    }

    var scopeButtons = ui.scopeSegment.querySelectorAll('[data-scope]');
    for (var i = 0; i < scopeButtons.length; i += 1) {
      var btn = scopeButtons[i];
      btn.setAttribute('aria-checked', String(btn.getAttribute('data-scope') === s.scope));
    }

    document.body.classList.toggle('disabled', !enabled);
    updateClock();
  }

  /**
   * 双时钟：本机（系统时区）与伪装时区对照。
   * 两边都用显式 timeZone 的 Intl 计算，弹窗自身不会受影响。
   */
  function updateClock() {
    var s = state.settings;
    if (!s) return;
    var now = Date.now();

    var realTime;
    var maskedTime;
    try {
      realTime = new Intl.DateTimeFormat('zh-CN', {
        timeZone: (state.meta && state.meta.realZone) || undefined,
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(now);
    } catch (err) {
      realTime = new Date(now).toTimeString().slice(0, 8);
    }
    try {
      maskedTime = new Intl.DateTimeFormat('zh-CN', {
        timeZone: s.zone,
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(now);
    } catch (err) {
      maskedTime = '--:--:--';
    }

    ui.clockReal.textContent = realTime;
    ui.clockMasked.textContent = maskedTime;

    // 日期差提示：本机日期 vs 伪装日期
    var dayHint = '';
    try {
      var realDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: (state.meta && state.meta.realZone) || undefined,
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(now);
      var maskDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: s.zone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(now);
      if (realDay !== maskDay) {
        dayHint = realDay < maskDay ? '（后一日）' : '（前一日）';
      }
    } catch (err) {
      dayHint = '';
    }
    ui.clockDay.textContent = dayHint;
  }

  function startClock() {
    updateClock();
    clearInterval(state.tickTimer);
    state.tickTimer = setInterval(updateClock, 1000);
  }

  /**
   * 时区下拉框：置顶「推荐」分组，其余按 IANA 名称排序。
   * 搜索时按标签 / IANA 名称过滤，最多展示 SEARCH_LIMIT 条。
   */
  function renderZones(keyword) {
    var query = String(keyword || '').trim().toLowerCase();
    var zones = state.zones;

    if (query) {
      zones = zones.filter(function (item) {
        return item.zone.toLowerCase().indexOf(query) >= 0 ||
          String(item.label || '').toLowerCase().indexOf(query) >= 0 ||
          String(item.slug || '').indexOf(query.replace(/\s+/g, '_')) >= 0;
      });
    }
    state.filtered = zones;

    var select = ui.zoneSelect;
    select.textContent = '';

    var selected = state.settings ? state.settings.zone : '';
    var shown = 0;
    var matchedSelected = false;

    function addGroup(label) {
      if (!label) return null;
      var group = document.createElement('optgroup');
      group.label = label;
      select.appendChild(group);
      return group;
    }

    function addOption(parent, item) {
      var option = document.createElement('option');
      option.value = item.zone;
      option.textContent = item.recommended ? '⭐ ' + item.label : item.label;
      option.title = item.zone;
      if (item.zone === selected) { option.selected = true; matchedSelected = true; }
      parent.appendChild(option);
      shown += 1;
    }

    if (!query) {
      var recommended = zones.filter(function (item) { return item.recommended; });
      var others = zones.filter(function (item) { return !item.recommended; });
      var groupRec = addGroup('推荐时区');
      recommended.forEach(function (item) { addOption(groupRec, item); });
      var groupAll = addGroup('全部时区（' + others.length + '）');
      others.forEach(function (item) { addOption(groupAll, item); });
    } else {
      var groupMatch = addGroup('匹配结果（' + zones.length + '）');
      zones.slice(0, SEARCH_LIMIT).forEach(function (item) { addOption(groupMatch, item); });
    }

    if (!shown) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '没有匹配的时区';
      select.appendChild(empty);
      select.value = '';
      select.disabled = true;
      return;
    }
    select.disabled = false;

    // 搜索状态下如果当前选中项被过滤掉了，下拉框先回落到第一项（不写入设置）
    if (matchedSelected) {
      select.value = selected;
    } else if (query) {
      select.value = state.filtered[0].zone;
    } else {
      select.value = selected;
    }
  }

  /*
   * 检测结果里的 zone / now 等字段来自页面 MAIN world——
   * 页面可以覆写 Intl/Date，因此这些值属于**不可信输入**。
   * 必须用 textContent 构建 DOM，绝不能拼 innerHTML，否则页面可在弹窗里注入伪造 UI。
   */
  function renderCheckResult(result) {
    var box = ui.checkResult;
    box.hidden = false;
    box.className = 'check-result ' + String(result.kind || '');
    while (box.firstChild) box.removeChild(box.firstChild);

    var title = document.createElement('div');
    title.textContent = String(result.title == null ? '' : result.title);
    box.appendChild(title);

    (result.lines || []).forEach(function (line) {
      var row = document.createElement('div');
      row.className = 'kv-line';

      var key = document.createElement('span');
      key.textContent = String(line[0] == null ? '' : line[0]);
      var value = document.createElement('span');
      value.textContent = String(line[1] == null ? '' : line[1]);

      row.appendChild(key);
      row.appendChild(value);
      box.appendChild(row);
    });
  }

  function clearCheckResult() {
    var box = ui.checkResult;
    box.hidden = true;
    box.textContent = '';
    box.className = 'check-result';
  }

  /* ============================ 数据加载 ============================ */

  /*
   * 时区目录由后台提供。
   * 不要在这里解析 shared/zones.js 的源码文本——那个文件头注释里含
   * "[{ zone, label, slug, recommended }]"，任何 indexOf('[') 之类的切法都会切歪，
   * 结果被 catch 吞掉后静默回落成单条默认时区（419 个时区全部不可选）。
   */
  function loadZones() {
    return send({ type: 'getZones' }).then(function (res) {
      if (!res || !res.ok || !Array.isArray(res.zones)) return [];
      return res.zones;
    }).catch(function () { return []; });
  }

  function readState() {
    return send({ type: 'getState' });
  }

  function saveState(patch) {
    return send({ type: 'setState', patch: patch });
  }

  /* ============================ 交互 ============================ */

  function applyStateResponse(res) {
    if (!res || !res.ok) {
      toast('读取设置失败：' + ((res && res.error) || '未知错误'));
      return false;
    }
    state.settings = res.state;
    if (res.meta) state.meta = res.meta;
    return true;
  }

  /*
   * 保存设置。
   *
   * 不要用「单个 timer 覆盖上一个 patch」的写法：用户在 200ms 内先后改了
   * 开关和时区，前一个 patch 会被 clearTimeout 掉，导致那次修改静默丢失。
   * 这里改为「合并待发送的 patch + 只在没有在途请求时发起下一次」。
   */
  var pendingPatch = null;
  var pendingMessage = '';
  var pendingRerender = false;
  var saving = false;

  function handlePatch(patch, options) {
    var opts = options || {};
    pendingPatch = Object.assign(pendingPatch || {}, patch);
    if (opts.message) pendingMessage = opts.message;
    if (opts.rerenderZones) pendingRerender = true;
    scheduleSave(opts.debounce ? 200 : 0);
  }

  function scheduleSave(delay) {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushPatch, delay);
  }

  /*
   * 保存期间的兜底定时器。
   *
   * 之前有个致命 bug：saving 置 true 后，如果 saveState 返回的 Promise
   * 永远不 settle（后台 SW 被回收、消息通道断开等），saving 就永远卡在 true，
   * 此后所有用户操作都被 if (saving) return 挡掉 —— 表现就是「点开关没反应」。
   *
   * 现在加一个超时：15 秒后强制解除 saving 状态并提示。
   */
  var saveGuardTimer = null;
  var SAVE_TIMEOUT_MS = 15000;

  function releaseSaving() {
    saving = false;
    if (saveGuardTimer) {
      clearTimeout(saveGuardTimer);
      saveGuardTimer = null;
    }
  }

  function flushPatch() {
    if (saving || !pendingPatch) return;

    var patch = pendingPatch;
    var message = pendingMessage;
    var rerender = pendingRerender;
    pendingPatch = null;
    pendingMessage = '';
    pendingRerender = false;
    saving = true;

    // 超时兜底：防止 Promise 不 settle 导致后续操作全部失灵
    if (saveGuardTimer) clearTimeout(saveGuardTimer);
    saveGuardTimer = setTimeout(function () {
      if (!saving) return;
      releaseSaving();
      toast('保存超时，请重试（后台可能已休眠）');
      if (pendingPatch) flushPatch();
    }, SAVE_TIMEOUT_MS);

    saveState(patch).then(function (res) {
      releaseSaving();
      if (!applyStateResponse(res)) {
        toast((res && res.error) || '保存失败');
        return;
      }
      renderStatus();
      if (message) {
        flashSaved();
        toast(message);
      }
      if (rerender) renderZones(ui.zoneSearch.value);
      // 期间如果又攒了新 patch，继续发
      if (pendingPatch) flushPatch();
    }).catch(function (err) {
      releaseSaving();
      toast('保存失败：' + ((err && err.message) || err));
      if (pendingPatch) flushPatch();
    });
  }

  function bindToggle() {
    ui.toggle.addEventListener('change', function () {
      var enabled = ui.toggle.checked;
      // 先乐观更新，避免闪烁
      ui.statusDot.className = 'dot ' + (enabled ? 'on' : 'off');
      ui.statusText.textContent = enabled ? '已生效 · 页面时区会被伪装' : '已关闭 · 页面使用真实时区';
      handlePatch({ enabled: enabled }, {
        message: enabled ? '已开启，刷新页面后生效' : '已关闭，刷新页面后恢复真实时区'
      });
    });
  }

  function bindZoneSelect() {
    ui.zoneSelect.addEventListener('change', function () {
      var zone = ui.zoneSelect.value;
      if (!zone || (state.settings && zone === state.settings.zone)) return;
      handlePatch({ zone: zone }, { message: '时区已切换，刷新页面后生效', rerenderZones: false });
    });

    ui.zoneSearch.addEventListener('input', function () {
      renderZones(ui.zoneSearch.value);
    });

    ui.zoneSearch.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        var first = state.filtered[0];
        if (first) {
          ui.zoneSearch.value = '';
          renderZones('');
          ui.zoneSelect.value = first.zone;
          handlePatch({ zone: first.zone }, { message: '时区已切换，刷新页面后生效' });
        }
      } else if (event.key === 'Escape') {
        ui.zoneSearch.value = '';
        renderZones('');
      }
    });
  }

  function bindScope() {
    ui.scopeSegment.addEventListener('click', function (event) {
      var target = event.target.closest('[data-scope]');
      if (!target) return;
      var scope = target.getAttribute('data-scope');
      if (!scope || (state.settings && scope === state.settings.scope)) return;
      handlePatch({ scope: scope }, {
        message: scope === 'all' ? '已切换到「所有网站」，刷新页面后生效' : '已切换到「仅 ChatGPT 站点」'
      });
    });
  }

  /* ==================== 出口 IP → 时区匹配 ==================== */

  /*
   * 为什么做这个：
   *   社区反馈（locdd / CSDN / macos.do）一致认为「时区必须和出口 IP 一致」，
   *   而不是「一律选美国」。IP 在日本却选洛杉矶，等于主动制造矛盾信号。
   *   这里自动查出口 IP 所在地区，推荐/设置匹配的时区。
   *
   * 隐私：只请求 ipinfo.io/json（一个公开的 IP 归属查询），不带任何标识。
   */

  /** 国家/地区 → 推荐的 IANA 时区（按覆盖人口与代理节点常见度排序） */
  var COUNTRY_ZONE = {
    US: 'America/Los_Angeles',     // 美国（默认西海岸；东部用户可手动改 New_York）
    CA: 'America/Toronto',
    MX: 'America/Mexico_City',
    BR: 'America/Sao_Paulo',
    AR: 'America/Argentina/Salta',
    GB: 'Europe/London',
    IE: 'Europe/Dublin',
    FR: 'Europe/Paris',
    DE: 'Europe/Berlin',
    NL: 'Europe/Amsterdam',
    BE: 'Europe/Brussels',
    CH: 'Europe/Zurich',
    AT: 'Europe/Vienna',
    IT: 'Europe/Rome',
    ES: 'Europe/Madrid',
    PT: 'Europe/Lisbon',
    SE: 'Europe/Stockholm',
    NO: 'Europe/Oslo',
    DK: 'Europe/Copenhagen',
    FI: 'Europe/Helsinki',
    PL: 'Europe/Warsaw',
    CZ: 'Europe/Prague',
    RU: 'Europe/Moscow',
    TR: 'Europe/Istanbul',
    UA: 'Europe/Kiev',          // ICU 规范名（Kyiv 是新区名，ICU 仍用 Kiev）
    AE: 'Asia/Dubai',
    IL: 'Asia/Jerusalem',
    IN: 'Asia/Calcutta',
    SG: 'Asia/Singapore',
    MY: 'Asia/Kuala_Lumpur',
    TH: 'Asia/Bangkok',
    VN: 'Asia/Saigon',          // ICU 规范名（Ho_Chi_Minh 是旧区名）
    ID: 'Asia/Jakarta',
    PH: 'Asia/Manila',
    HK: 'Asia/Hong_Kong',
    TW: 'Asia/Taipei',
    KR: 'Asia/Seoul',
    JP: 'Asia/Tokyo',
    CN: 'Asia/Shanghai',
    AU: 'Australia/Sydney',
    NZ: 'Pacific/Auckland',
    ZA: 'Africa/Johannesburg',
    EG: 'Africa/Cairo',
    NG: 'Africa/Lagos'
  };

  /** 查询出口 IP 与归属地。失败时返回 {ok:false}，绝不抛错。 */
  /*
   * 查询出口 IP 与归属地。
   *
   * 踩过的坑：
   *   1. api.ipify.org 只返回 IP，**没有 country 字段** —— 早期把它当备选，
   *      导致 ipinfo 失败时页面显示 "IP · ??" 且无法匹配时区。
   *   2. ipinfo 对部分 IP（私有段/保留段/新分配段）会返回 bogon:true 且不带 country。
   *   3. 有些接口需要走不同域名才能绕过地区限制。
   *
   * 所以这里按「是否真的拿到 country」来判断成功，而不是「有没有响应」。
   */
  var IP_ENDPOINTS = [
    {
      url: 'https://ipinfo.io/json',
      parse: function (d) { return { ip: d.ip, country: d.country, region: d.region, city: d.city }; }
    },
    {
      // Cloudflare trace：纯文本，稳定且有 loc 字段（国家代码）
      url: 'https://www.cloudflare.com/cdn-cgi/trace',
      parse: function (text) {
        var map = {};
        String(text).split('\n').forEach(function (line) {
          var i = line.indexOf('=');
          if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
        });
        return { ip: map.ip, country: map.loc, region: '', city: '' };
      },
      isText: true
    },
    {
      // ip-api：字段名不同（countryCode / query）
      url: 'https://ip-api.com/json/?fields=status,country,countryCode,regionName,city,query',
      parse: function (d) {
        if (d.status && d.status !== 'success') return {};
        return { ip: d.query, country: d.countryCode, region: d.regionName, city: d.city };
      }
    },
    {
      // 兜底：只有 IP，没有国家。仅用于显示，绝不用于匹配时区
      url: 'https://api.ipify.org?format=json',
      parse: function (d) { return { ip: d.ip, country: '', region: '', city: '' }; }
    }
  ];

  function detectExitIp() {
    function tryNext(i, fallbackIp) {
      if (i >= IP_ENDPOINTS.length) {
        // 一个都没拿到国家，但至少有 IP 的话也返回，界面会提示手动选
        if (fallbackIp) return Promise.resolve({ ok: true, ip: fallbackIp, country: '', region: '', city: '', countryUnknown: true });
        return Promise.resolve({ ok: false, error: '所有 IP 查询接口均失败' });
      }

      var ep = IP_ENDPOINTS[i];
      return fetch(ep.url, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return ep.isText ? res.text() : res.json();
        })
        .then(function (raw) {
          var info = ep.parse(raw) || {};
          var ip = info.ip || '';
          var country = String(info.country || '').toUpperCase();
          if (!ip) throw new Error('无 IP 字段');
          if (!country) {
            // 拿到 IP 但没国家：记下来继续试下一个接口
            return tryNext(i + 1, fallbackIp || ip);
          }
          return {
            ok: true,
            ip: ip,
            country: country,
            region: info.region || '',
            city: info.city || '',
            source: ep.url
          };
        })
        .catch(function () { return tryNext(i + 1, fallbackIp); });
    }
    return tryNext(0, '');
  }

  /** 把国家代码映射成时区；没有映射时返回 null */
  function zoneForCountry(country) {
    if (!country) return null;
    var zone = COUNTRY_ZONE[country];
    if (!zone) return null;
    // 确认这个时区在目录里（避免设置一个不存在的值）
    for (var i = 0; i < state.zones.length; i++) {
      if (state.zones[i].zone === zone) return zone;
    }
    return null;
  }

  /** 渲染出口 IP 卡片：显示 IP/地区，并判断与当前时区是否一致 */
  function renderIpCard(info) {
    if (!ui.ipRow) return;

    if (!info || !info.ok) {
      ui.ipRow.className = 'ip-row';
      ui.ipValue.textContent = '未检测';
      ui.ipHint.className = 'ip-hint';
      ui.ipHint.textContent = '点「跟随代理」自动把时区设成与你出口 IP 一致';
      return;
    }

    var country = info.country || '';
    var suggested = zoneForCountry(country);
    var currentZone = state.settings ? state.settings.zone : '';
    var match = suggested && suggested === currentZone;

    // 国家未知时不要显示 "??" 这种让人困惑的东西
    var locText = country ? (info.city ? country + ' ' + info.city : country) : '未知地区';
    ui.ipValue.textContent = info.ip + ' · ' + locText;

    if (info.countryUnknown || !country) {
      ui.ipRow.className = 'ip-row warn';
      ui.ipHint.className = 'ip-hint warn';
      ui.ipHint.textContent = '查到了 IP 但识别不出地区（可能是私有地址或被接口限流），请手动选择时区';
      return;
    }

    if (!suggested) {
      ui.ipRow.className = 'ip-row';
      ui.ipHint.className = 'ip-hint';
      ui.ipHint.textContent = '该地区（' + country + '）暂无预置时区映射，请手动选择接近的时区';
      return;
    }

    if (match) {
      ui.ipRow.className = 'ip-row ok';
      ui.ipHint.className = 'ip-hint';
      ui.ipHint.textContent = '时区与出口 IP 一致 ✓';
    } else {
      ui.ipRow.className = 'ip-row warn';
      ui.ipHint.className = 'ip-hint warn';
      ui.ipHint.textContent = '当前时区与出口 IP 不一致，建议点击「跟随代理」改成 ' + suggested;
    }
  }

  function bindIpDetect() {
    if (!ui.btnDetectIp) return;

    ui.btnDetectIp.addEventListener('click', function () {
      var btn = ui.btnDetectIp;
      if (btn.classList.contains('busy')) return;

      btn.classList.add('busy');
      btn.disabled = true;
      ui.ipValue.textContent = '查询中…';
      ui.ipHint.className = 'ip-hint';
      ui.ipHint.textContent = '正在查询出口 IP…';

      detectExitIp().then(function (info) {
        btn.classList.remove('busy');
        btn.disabled = false;

        if (!info.ok) {
          ui.ipRow.className = 'ip-row bad';
          ui.ipValue.textContent = '查询失败';
          ui.ipHint.className = 'ip-hint bad';
          ui.ipHint.textContent = '无法查询出口 IP（可能被网络限制），请手动选择时区';
          return;
        }

        var zone = zoneForCountry(info.country);
        renderIpCard(info);

        if (!zone) {
          toast('IP 在 ' + info.country + '，但没有对应的预置时区，请手动选择');
          return;
        }

        if (state.settings && state.settings.zone === zone) {
          toast('时区已经是 ' + zone + '，与出口 IP 一致 ✓');
          return;
        }

        // 自动切换
        ui.zoneSelect.value = zone;
        handlePatch({ zone: zone }, { message: '已跟随代理切换到 ' + zone });
        toast('已切换为 ' + zone + '，刷新页面后生效');
      });
    });
  }

  function bindWebrtc() {
    if (!ui.webrtcToggle) return;
    ui.webrtcToggle.addEventListener('change', function () {
      var on = ui.webrtcToggle.checked;
      handlePatch({ webrtc: on }, {
        message: on ? '已开启 WebRTC 防护，刷新页面后生效' : '已关闭 WebRTC 防护，刷新页面后生效'
      });
    });
  }

  function bindBrowserProxy() {
    if (ui.proxyToggle) {
      ui.proxyToggle.addEventListener('change', function () {
        var on = ui.proxyToggle.checked;
        handlePatch({ browserProxy: on }, {
          message: on ? 'ChatGPT 将强制走代理，其它网站不受影响' : '已恢复按系统代理规则分流'
        });
        updateProxyHint(on);
      });
    }

    if (ui.proxyPort) {
      var portTimer = null;
      ui.proxyPort.addEventListener('input', function () {
        clearTimeout(portTimer);
        portTimer = setTimeout(function () {
          var v = parseInt(ui.proxyPort.value, 10);
          if (!v || v < 1 || v > 65535) {
            toast('端口必须是 1-65535');
            return;
          }
          handlePatch({ proxyPort: v }, { message: '专用端口已更新为 ' + v });
        }, 500);
      });
    }
  }

  function updateProxyHint(on) {
    if (!ui.proxyHint) return;
    if (on) {
      ui.proxyHint.className = 'ip-hint warn';
      ui.proxyHint.textContent = '已开启。请确认 Clash 的 Merge 配置里有对应端口的 listeners，否则 ChatGPT 会连不上。';
    } else {
      ui.proxyHint.className = 'ip-hint';
      ui.proxyHint.textContent = '需要在 Clash 的 Merge 配置里添加同名 listeners 端口（见说明文档）';
    }
  }

  function bindFont() {
    if (!ui.fontToggle) return;
    ui.fontToggle.addEventListener('change', function () {
      var on = ui.fontToggle.checked;
      handlePatch({ font: on }, {
        message: on ? '已隐藏中文字体特征，刷新页面后生效' : '已恢复字体探测，刷新页面后生效'
      });
    });
  }

  function activeTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          resolve((tabs && tabs[0]) || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function bindActions() {
    ui.btnCheck.addEventListener('click', function () {
      var btn = ui.btnCheck;
      setBusy(btn, true);
      activeTab().then(function (tab) {
        if (!tab || typeof tab.id !== 'number') {
          setBusy(btn, false);
          renderCheckResult({ kind: 'warn', title: '找不到当前标签页', lines: [['提示', '请先打开一个普通网页']] });
          return;
        }
        send({ type: 'checkTab', tabId: tab.id }).then(function (res) {
          setBusy(btn, false);
          if (!res || !res.ok) {
            renderCheckResult({
              kind: 'warn',
              title: '这个页面暂时无法检测',
              lines: [['原因', (res && res.error) || '未知错误']]
            });
            return;
          }
          var r = res.result || {};
          var expected = state.settings ? state.settings.zone : '';
          var match = r.zone === expected;
          var host = '';
          try { host = new URL(tab.url).hostname; } catch (err) { host = tab.url || ''; }
          renderCheckResult({
            kind: match ? 'ok' : 'bad',
            title: match ? '这个页面已经生效 ✓' : '这个页面还没生效，刷新一下试试',
            lines: [
              ['页面', host],
              ['页面时区', String(r.zone)],
              ['伪装脚本', r.hasShim ? '已注入' : '未检测到'],
              ['页面时间', r.now || '—']
            ]
          });
          ui.statusDot.className = 'dot ' + (match ? 'on' : 'err');
          ui.statusText.textContent = match ? '已生效 · 页面时区会被伪装' : '当前页面未生效，请刷新';
        });
      });
    });

    ui.btnReload.addEventListener('click', function () {
      activeTab().then(function (tab) {
        if (!tab || typeof tab.id !== 'number') { toast('找不到当前标签页'); return; }
        send({ type: 'reloadTab', tabId: tab.id }).then(function (res) {
          if (!res || !res.ok) { toast('刷新失败：' + ((res && res.error) || '未知错误')); return; }
          toast('已刷新');
          clearCheckResult();
        });
      });
    });

    ui.btnOpen.addEventListener('click', function () {
      send({ type: 'openChatGPT' }).then(function (res) {
        if (!res || !res.ok) toast('打开失败：' + ((res && res.error) || '未知错误'));
        else window.close();
      });
    });

    ui.btnVerify.addEventListener('click', function () {
      send({ type: 'openVerify' }).then(function (res) {
        if (!res || !res.ok) { toast('打开自检页失败'); return; }
        window.close();
      });
    });

    ui.btnCopy.addEventListener('click', function () {
      var payload = {
        product: 'ChatGPT 时区修复',
        generatedAt: new Date().toISOString(),
        state: state.settings,
        meta: state.meta,
        check: ui.checkResult.hidden ? null : ui.checkResult.textContent,
        userAgent: navigator.userAgent,
        chrome: navigator.userAgentData ? 'ua-ch' : 'ua'
      };
      var text = JSON.stringify(payload, null, 2);
      var done = function () { toast('诊断信息已复制'); };
      var fallback = function () {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (err) { toast('复制失败，请手动选择'); }
        ta.remove();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else {
        fallback();
      }
    });
  }

  /* ============================ 初始化 ============================ */

  /** 一次性抓取所有需要的 DOM 节点（id 与 ui 字段一一对应） */
  function cacheDom() {
    ui.toggle = document.getElementById('toggle');
    ui.statusDot = document.getElementById('statusDot');
    ui.statusText = document.getElementById('statusText');
    ui.realZone = document.getElementById('realZone');
    ui.maskZone = document.getElementById('maskZone');
    ui.clockReal = document.getElementById('clockReal');
    ui.clockMasked = document.getElementById('clockMasked');
    ui.clockDay = document.getElementById('clockDay');
    ui.checkResult = document.getElementById('checkResult');
    ui.zoneSearch = document.getElementById('zoneSearch');
    ui.zoneSelect = document.getElementById('zoneSelect');
    ui.savedHint = document.getElementById('savedHint');
    ui.scopeSegment = document.getElementById('scopeSegment');
    ui.webrtcToggle = document.getElementById('webrtcToggle');
    ui.fontToggle = document.getElementById('fontToggle');
    ui.proxyToggle = document.getElementById('proxyToggle');
    ui.proxyPort = document.getElementById('proxyPort');
    ui.proxyHint = document.getElementById('proxyHint');
    ui.ipRow = document.getElementById('ipRow');
    ui.ipValue = document.getElementById('ipValue');
    ui.ipHint = document.getElementById('ipHint');
    ui.btnDetectIp = document.getElementById('btnDetectIp');
    ui.btnCheck = document.getElementById('btnCheck');
    ui.btnReload = document.getElementById('btnReload');
    ui.btnOpen = document.getElementById('btnOpen');
    ui.btnVerify = document.getElementById('btnVerify');
    ui.btnCopy = document.getElementById('btnCopy');
    ui.version = document.getElementById('version');
    ui.toast = document.getElementById('toast');
  }

  function init() {
    cacheDom();
    bindToggle();
    bindZoneSelect();
    bindScope();
    bindWebrtc();
    bindFont();
    bindBrowserProxy();
    bindIpDetect();
    bindActions();

    if (ui.version) {
      try { ui.version.textContent = 'v' + chrome.runtime.getManifest().version; } catch (err) { ui.version.textContent = 'v—'; }
    }

    loadZones().then(function (zones) {
      state.zones = zones.length ? zones : [{ zone: FALLBACK_STATE.zone, label: FALLBACK_STATE.zone, slug: 'america_los_angeles', recommended: true }];
      return readState();
    }).then(function (res) {
      if (!applyStateResponse(res)) {
        state.settings = Object.assign({}, FALLBACK_STATE);
        state.meta = state.meta || {};
      }
      renderZones('');
      renderStatus();
      startClock();

      /*
       * 打开弹窗时静默查一次出口 IP，只用于显示一致性提示，**不自动改时区**。
       * 自动改会让用户莫名其妙——必须由用户点「跟随代理」明确触发。
       */
      ui.ipValue.textContent = '查询中…';
      detectExitIp().then(function (info) {
        if (info.ok) renderIpCard(info);
        else ui.ipValue.textContent = '未检测';
      });
    }).catch(function (err) {
      toast('初始化失败：' + ((err && err.message) || err));
    });

    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.settings) return;
        state.settings = changes.settings.newValue;
        renderZones(ui.zoneSearch.value);
        renderStatus();
      });
    } catch (err) { /* 忽略 */ }

    window.addEventListener('unload', function () { clearInterval(state.tickTimer); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
