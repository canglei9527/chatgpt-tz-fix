/* 时区修复 · 背景服务（MV3 service worker，classic） */
'use strict';

importScripts('shared/zones.js');

/** 动态内容脚本的固定 id */
const SCRIPT_ID = 'tz-main';
/** 注入文件顺序：先写时区，再跑伪装脚本 */
const INJECT_FILES = ['inject/zones/ZONE_SLUG.js', 'inject/tz-shim.js'];

/** 默认设置（chrome.storage.local 单 key） */
const DEFAULT_STATE = Object.freeze({
  v: 1,
  enabled: true,
  zone: 'America/Los_Angeles',
  scope: 'chatgpt',
  // WebRTC 本机 IP 防泄露：默认关闭，避免影响视频通话类站点；用户可在弹窗里打开
  webrtc: false
});
/** 允许的生效范围 */
const SCOPES = Object.freeze(['chatgpt', 'all']);
/** 各范围对应的 matches */
const MATCHES = Object.freeze({
  chatgpt: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*', 'https://chat.openai.com/*', 'https://*.openai.com/*'],
  all: ['<all_urls>'],
});
/** 徽标颜色 */
const BADGE_COLOR = '#16a34a';
/** 无法注入内容脚本的页面协议 / 域名 */
const BLOCKED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|data|blob):/i;
const BLOCKED_HOST = /(^|\.)(chrome\.google\.com|chromewebstore\.google\.com)$/i;

/** 读取时区目录，异常时返回空数组 */
function getZones() {
  const zones = globalThis.DSH_TZ_ZONES;
  return Array.isArray(zones) ? zones : [];
}

/** 按 IANA 名称查目录项 */
function findZone(zone) {
  return getZones().find((item) => item && item.zone === zone) || null;
}

/** 取系统真实时区（service worker 未被伪装） */
function getRealZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (err) {
    return 'UTC';
  }
}

/** 把任意输入规整成合法状态；非法字段回落到默认值 */
function normalizeState(input) {
  const source = input && typeof input === 'object' ? input : {};
  const zone = typeof source.zone === 'string' && findZone(source.zone) ? source.zone : DEFAULT_STATE.zone;
  const scope = SCOPES.includes(source.scope) ? source.scope : DEFAULT_STATE.scope;
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_STATE.enabled;
  const webrtc = typeof source.webrtc === 'boolean' ? source.webrtc : DEFAULT_STATE.webrtc;
  return { v: DEFAULT_STATE.v, enabled, zone, scope, webrtc };
}

/** 单条校验：返回错误文案，通过返回 null */
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return '参数格式不正确';
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') return 'enabled 必须是布尔值';
  if ('scope' in patch && !SCOPES.includes(patch.scope)) return '不支持的生效范围：' + String(patch.scope);
  if ('webrtc' in patch && typeof patch.webrtc !== 'boolean') return 'webrtc 必须是布尔值';
  if ('zone' in patch && !findZone(patch.zone)) return '未知时区：' + String(patch.zone);
  return null;
}

/** 读取设置（读失败回落到默认值） */
/** 上次成功读到的状态：storage 暂时读失败时用它兜底，避免把用户配置冲成默认值 */
let lastKnownState = null;

/**
 * 最近一次注册失败的原因。
 * 早期实现只 console.warn 就返回 false，用户在界面上只看到"未生效"，
 * 完全查不到是权限问题、参数问题还是浏览器版本问题。这里留痕，供 getState/diagnose 上报。
 */
const lastRegistration = { ok: false, error: null, at: null, files: null, matches: null };

/**
 * 读取设置。
 *
 * 关键：读失败 ≠ 没有设置。
 * 早期实现在 catch 里返回 normalizeState(null)（即默认值），
 * 上层如果顺手写回（setState/init），用户的 zone/scope 就被永久冲成默认。
 * 现在失败时优先返回 lastKnownState；连它都没有才回落到默认值，并且绝不写回。
 */
async function readState() {
  try {
    const got = await chrome.storage.local.get('settings');
    const state = normalizeState(got && got.settings);
    lastKnownState = state;
    return state;
  } catch (err) {
    console.warn('[tz-fix] 读取设置失败：', err && err.message);
    if (lastKnownState) return lastKnownState;
    return normalizeState(null);
  }
}

/** 读取设置，并告诉调用方这次是否读成功（失败时调用方不应写回） */
async function readStateChecked() {
  try {
    const got = await chrome.storage.local.get('settings');
    const state = normalizeState(got && got.settings);
    lastKnownState = state;
    return { ok: true, state };
  } catch (err) {
    console.warn('[tz-fix] 读取设置失败：', err && err.message);
    return { ok: false, state: lastKnownState || normalizeState(null) };
  }
}

/** 写入设置 */
async function writeState(state) {
  await chrome.storage.local.set({ settings: state });
  return state;
}

/** 当前状态对应的 matches */
function resolveMatches(scope) {
  return MATCHES[scope] || MATCHES.chatgpt;
}

/** 当前状态对应的注入文件列表 */
/**
 * 计算要注入的文件列表。
 *
 * 顺序很关键：
 *   1. zones/<slug>.js  —— 先放好目标时区变量
 *   2. webrtc-guard.js  —— 可选，屏蔽会泄露真实 IP 的 ICE 候选
 *   3. tz-shim.js       —— 最后装时区伪装
 */
function resolveFiles(zone, webrtc) {
  const entry = findZone(zone);
  const slug = entry ? entry.slug : 'america_los_angeles';
  const files = [INJECT_FILES[0].replace('ZONE_SLUG', slug)];
  if (webrtc) files.push('inject/webrtc-guard.js');
  files.push(INJECT_FILES[1]);
  return files;
}

/** 注销内容脚本；not-found 属于正常情况，直接忽略 */
async function unregisterScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!/not\s*found|no\s+content\s+script/i.test(message)) {
      console.warn('[tz-fix] 注销内容脚本失败：' + message);
    }
  }
}

/** 更新扩展徽标 */
async function updateBadge(enabled) {
  try {
    await chrome.action.setBadgeText({ text: enabled ? 'TZ' : '' });
    if (enabled) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } catch (err) {
    console.warn('[tz-fix] 更新徽标失败：', err && err.message);
  }
}

/**
 * 注册/注销必须串行化。
 *
 * 否则会出现：用户点"关闭" → storage 写入 enabled=false → 触发 unregister，
 * 但先前那个"开启"请求的 register 晚到，最终脚本又被注册回去，
 * 而 popup 显示"已保存"——伪装实际状态与 UI 不符。
 * 这里用一条 Promise 链把所有变更排队，任何时刻只有一个操作在执行。
 */
let registerQueue = Promise.resolve();

/**
 * 按状态重新注册内容脚本（串行执行）。
 * enabled=false 时只注销；任何异常都只记警告，绝不抛出。
 *
 * @param {object} [stateInput] 期望状态；省略时读存储（始终以存储为准，避免 UI 与真实状态漂移）
 */
function ensureRegistered(stateInput) {
  /*
   * 注意：必须返回「本次任务」的 promise，不能返回队列本身。
   * 返回队列的话，调用方 await 到的是队列尾（可能包含后续排入的任务），
   * 在 storage.onChanged 这类会重入的场景里会互相等待、直接死锁。
   */
  const task = registerQueue
    .then(() => applyRegistration(stateInput))
    .catch((err) => {
      console.warn('[tz-fix] 注册队列异常：', err && err.message);
      return false;
    });

  // 队列自身要吞掉异常，否则一次失败会让后续所有任务短路
  registerQueue = task.catch(() => false);
  return task;
}

async function applyRegistration(stateInput) {
  const state = stateInput ? normalizeState(stateInput) : await readState();
  await unregisterScript();

  if (!state.enabled) {
    await updateBadge(false);
    return false;
  }

  const matches = resolveMatches(state.scope);
  const files = resolveFiles(state.zone, state.webrtc);
  lastRegistration.files = files;
  lastRegistration.matches = matches;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches,
        /*
         * 注意：这里的属性名必须是 js，不是 files。
         * chrome.scripting.registerContentScripts 的 RegisteredContentScript
         * 定义是 js: string[]；写成 files 会被 Chrome 直接拒绝：
         *   "Error at parameter 'scripts': Error at index 0: Unexpected property: 'files'."
         * manifest.json 的静态 content_scripts 用的是 js，两者容易混淆。
         */
        js: files,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
    lastRegistration.ok = true;
    lastRegistration.error = null;
    lastRegistration.at = Date.now();
    await updateBadge(true);
    return true;
  } catch (err) {
    const message = String((err && err.message) || err);
    lastRegistration.at = Date.now();

    // 重复注册：说明状态已经是对的（并发场景），不需要再报错
    if (/duplicate|already exists/i.test(message)) {
      lastRegistration.ok = true;
      lastRegistration.error = null;
      await updateBadge(true);
      return true;
    }

    lastRegistration.ok = false;
    lastRegistration.error = message;
    console.warn('[tz-fix] 注册内容脚本失败：' + message);
    return false;
  }
}

/** 查询内容脚本是否已注册 */
async function isScriptRegistered() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    return Array.isArray(scripts) && scripts.some((item) => item && item.id === SCRIPT_ID);
  } catch (err) {
    return false;
  }
}

/** 打开指定 URL 的新标签页 */
async function openTab(url) {
  try {
    await chrome.tabs.create({ url });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: '打开标签页失败：' + String((err && err.message) || err) };
  }
}

/** 判断标签页是否允许注入 */
function isInjectableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (BLOCKED_URL.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (BLOCKED_HOST.test(parsed.hostname)) return false;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

/** 校验 tabId */
function normalizeTabId(tabId) {
  const id = Number(tabId);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * 在目标标签页的 MAIN world 里读取时区信息。
 * 注意：这个函数会被序列化后注入页面，不能引用外部变量。
 */
function probePageTimezone() {
  const date = new Date();
  const options = Intl.DateTimeFormat().resolvedOptions();
  const zone = (options && options.timeZone) || 'unknown';
  const shim = globalThis.__DSH_TZ_FIX__;
  const shimZone =
    (shim && (shim.zone || shim.timeZone)) ||
    globalThis.__DSH_TZ_FIX_ZONE__ ||
    null;
  return {
    zone,
    offset: -date.getTimezoneOffset() / 60,
    hasShim: Boolean(shim),
    shimZone: shimZone || null,
    now: date.toISOString(),
    ua: navigator.userAgent,
  };
}

/** 检测标签页时区；失败时给出可读的原因 */
async function checkTab(message) {
  const tabId = normalizeTabId(message && message.tabId);
  if (tabId === null) return { ok: false, error: '无效的标签页 id' };

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    return { ok: false, error: '找不到该标签页，可能已关闭' };
  }
  if (tab && !isInjectableUrl(tab.url)) {
    return { ok: false, error: '这个页面不支持检测（浏览器内置页 / 扩展页 / 商店页无法注入脚本），请切换到普通网页再试' };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: probePageTimezone,
    });
    const frameResult = Array.isArray(results) ? results.find((item) => item && item.result) : null;
    if (!frameResult) return { ok: false, error: '页面没有返回时区信息，请刷新后重试' };
    return { ok: true, result: frameResult.result };
  } catch (err) {
    const detail = String((err && err.message) || err);
    console.warn('[tz-fix] 检测标签页失败：' + detail);

    /*
     * 把常见的几类失败翻译成人能看懂的话。
     * 尤其是 "showing error page"——它表示该标签页当前是一个错误页
     * （网络中断、被拦截、加载失败），根本不是扩展的问题，
     * 用户看到"无法检测"会以为是扩展坏了。
     */
    if (/showing error page/i.test(detail)) {
      return {
        ok: false,
        error: '这个标签页当前是错误页（加载失败/网络中断/被拦截），不是扩展的问题。请在该标签页重新加载页面，或直接打开一个新的 ChatGPT 页面再检测。',
        reason: 'error-page',
      };
    }
    if (/no tab with id|cannot access|Cannot access contents/i.test(detail)) {
      return {
        ok: false,
        error: '无法访问该标签页（可能已被关闭，或是浏览器内置页）。请刷新标签页列表后重试。',
        reason: 'no-access',
      };
    }
    if (/Cannot access a chrome/i.test(detail)) {
      return {
        ok: false,
        error: '浏览器内置页面无法检测，请切换到普通网页（如 chatgpt.com）再试。',
        reason: 'restricted-url',
      };
    }

    return {
      ok: false,
      error: '无法在该页面执行检测：' + detail + '。可尝试刷新页面后重试。',
      reason: 'unknown',
      detail,
    };
  }
}

/** 处理来自 popup 的消息；统一返回 {ok, ...} */
async function handleMessage(message, sender) {
  void sender;
  switch (message.type) {
    case 'getState': {
      const read = await readStateChecked();

      /*
       * 自愈：如果脚本没注册，这里补一次。
       *
       * MV3 的 service worker 并非每次唤醒都会触发 onInstalled/onStartup——
       * 例如用户点了扩展页的"重新加载"，或 SW 因消息被唤醒时，
       * 这两个事件都不会触发，init() 也就不会跑，内容脚本永远是"未注册"状态。
       * 打开弹窗/自检页必然走到这里，是补注册最可靠的时机。
       */
      let registered = await isScriptRegistered();
      if (!registered && read.state.enabled) {
        registered = await ensureRegistered(read.state);
        if (registered) registered = await isScriptRegistered();
      }

      return {
        ok: true,
        state: read.state,
        meta: {
          realZone: getRealZone(),
          version: chrome.runtime.getManifest().version,
          scriptRegistered: registered,
          readOk: read.ok,
          // 注册失败时的真实原因，界面可直接展示
          registrationError: registered ? null : (lastRegistration.error || '未注册'),
          files: lastRegistration.files,
          matches: lastRegistration.matches,
        },
      };
    }
    case 'setState': {
      const patch = message.patch;
      const invalid = validatePatch(patch);
      if (invalid) return { ok: false, error: invalid };

      /*
       * 必须确认这次读是成功的再写回：如果 storage 暂时读失败，
       * readState 会回落到默认值，在此基础上合并 patch 再写回，
       * 就会把用户原来的 zone/scope 永久冲掉。
       */
      const read = await readStateChecked();
      if (!read.ok) {
        return { ok: false, error: '读取设置失败，请稍后重试（已保留原有设置）' };
      }

      const next = normalizeState({ ...read.state, ...patch });
      await writeState(next);
      lastKnownState = next;
      await ensureRegistered(next);
      return { ok: true, state: next };
    }
    case 'diagnose': {
      /*
       * 排查用：把"为什么没生效"需要的全部事实一次性返回。
       * 用户在自检页/弹窗点"复制诊断信息"时能拿到可读的原因。
       */
      const read = await readStateChecked();
      const registered = await isScriptRegistered();
      const scripts = await (async () => {
        try {
          return await chrome.scripting.getRegisteredContentScripts();
        } catch (err) {
          return [];
        }
      })();

      return {
        ok: true,
        state: read.state,
        readOk: read.ok,
        registered,
        allScripts: scripts.map((s) => ({
          id: s.id,
          matches: s.matches,
          files: s.files,
          world: s.world,
          runAt: s.runAt,
        })),
        lastRegistration: {
          ok: lastRegistration.ok,
          error: lastRegistration.error,
          at: lastRegistration.at,
          files: lastRegistration.files,
          matches: lastRegistration.matches,
        },
        manifest: {
          version: chrome.runtime.getManifest().version,
          minimumChrome: chrome.runtime.getManifest().minimum_chrome_version,
        },
        realZone: getRealZone(),
      };
    }
    case 'getZones':
      /*
       * 时区目录由 service worker 通过 importScripts 加载（见文件顶部），
       * 这里直接返回结构化数据，popup 不需要再解析 zones.js 的源码文本。
       * （早期版本让 popup 用 indexOf('[') 切 JSON，会被文件头注释里的
       *  "[{ zone, label, slug, recommended }]" 命中，导致 419 个时区全部丢失。）
       */
      return { ok: true, zones: getZones() };
    case 'checkTab':
      return checkTab(message);
    case 'reloadTab': {
      const tabId = normalizeTabId(message.tabId);
      if (tabId === null) return { ok: false, error: '无效的标签页 id' };
      try {
        await chrome.tabs.reload(tabId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: '刷新失败：' + String((err && err.message) || err) };
      }
    }
    case 'openChatGPT':
      return openTab('https://chatgpt.com/');
    case 'openVerify': {
      let url = '';
      try {
        url = chrome.runtime.getURL('verify/verify.html');
      } catch (err) {
        url = 'verify/verify.html';
      }
      return openTab(url);
    }
    default:
      return { ok: false, error: '未知的消息类型：' + String(message.type) };
  }
}

// 消息入口：异步返回必须 return true
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.warn('[tz-fix] 处理消息失败：', err && err.message);
      sendResponse({ ok: false, error: '后台处理失败：' + String((err && err.message) || err) });
    });
  return true;
});

/** 初始化：按当前设置注册脚本并更新徽标 */
async function init() {
  try {
    const state = await readState();
    await ensureRegistered(state);
    await updateBadge(state.enabled);
  } catch (err) {
    console.warn('[tz-fix] 初始化失败：', err && err.message);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  const reason = details && details.reason;
  init();
  if (reason === 'install') {
    openTab('https://chatgpt.com/');
  }
});

chrome.runtime.onStartup.addListener(() => {
  init();
});

/*
 * Service worker 每次被唤醒都会执行到这里。
 * MV3 下 onInstalled / onStartup 并不覆盖所有唤醒场景（点扩展页"重新加载"、
 * SW 因消息唤醒等），所以这里主动跑一次注册，保证任何路径下内容脚本都在。
 * init() 内部是幂等的（先注销再注册），重复调用安全。
 */
init();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes || !changes.settings) return;
  const next = normalizeState(changes.settings.newValue);
  // applyRegistration 内部已负责更新徽标，这里不再重复调用
  ensureRegistered(next);
});

// 仅用于单元测试的稳定性入口（浏览器运行时不产生副作用）
globalThis.__DSH_TZ_BG__ = Object.freeze({
  SCRIPT_ID,
  DEFAULT_STATE,
  MATCHES,
  normalizeState,
  validatePatch,
  resolveMatches,
  resolveFiles,
  ensureRegistered,
  readState,
  writeState,
  handleMessage,
  checkTab,
  init,
  getZones,
});
