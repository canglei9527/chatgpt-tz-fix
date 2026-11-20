#!/usr/bin/env node
/*
 * tests/ui-mock.test.cjs —— 扩展外壳的静态 + 行为测试
 *
 *  1. 用假的 chrome API 在 vm 里加载 background.js，断言注册参数、状态校验、消息分支
 *  2. 静态校验 manifest / popup / verify 页的文件引用是否齐全
 *  3. 校验 popup.js 引用的 DOM id 在 popup.html 中都存在
 *  4. 对扩展内所有 .js 跑 node --check
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const NODE = process.execPath;

const failures = [];
const notes = [];

function assert(name, condition, detail) {
  if (condition) {
    notes.push('  ✓ ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    notes.push('  ✗ ' + name);
  }
}

function readExt(rel) {
  return fs.readFileSync(path.join(EXT, rel), 'utf8');
}

function existsExt(rel) {
  try { return fs.statSync(path.join(EXT, rel)).isFile(); } catch (e) { return false; }
}

/* ---------- 1. 假 chrome API ---------- */

function createChromeMock(initialSettings) {
  const calls = { register: [], unregister: [], badge: [], created: [], executed: [], reloaded: [] };
  let stored = initialSettings ? { settings: initialSettings } : {};
  const listeners = { installed: [], startup: [], message: [], storage: [] };

  const chrome = {
    storage: {
      local: {
        get(key, cb) {
          const value = key ? { [key]: stored[key] } : Object.assign({}, stored);
          if (cb) { cb(value); return; }
          return Promise.resolve(value);
        },
        set(obj, cb) {
          stored = Object.assign({}, stored, obj);
          const changes = {};
          Object.keys(obj).forEach((k) => { changes[k] = { newValue: obj[k] }; });
          /*
           * 真实 Chrome 的 storage.onChanged 是**异步**派发的。
           * 早期这里是同步调用，导致 onChanged → ensureRegistered → get → set 的
           * 同步+微任务混合递归，测试直接卡死。
           */
          setTimeout(() => listeners.storage.forEach((fn) => fn(changes, 'local')), 0);
          if (cb) { cb(); return; }
          return Promise.resolve();
        }
      },
      onChanged: { addListener(fn) { listeners.storage.push(fn); } }
    },
    scripting: {
      async registerContentScripts(list, cb) {
        /*
         * 严格校验：真实 Chrome 会拒绝未定义的属性。
         * 早期 mock 无脑接受任何对象，导致 files/js 写错也测试通过（假绿）。
         * 这里按 RegisteredContentScript 的合法字段白名单校验。
         */
        const ALLOWED = new Set(['id', 'matches', 'js', 'css', 'runAt', 'world', 'allFrames', 'matchOriginAsFallback', 'persistAcrossSessions', 'excludeMatches', 'excludeGlobs', 'includeGlobs']);
        for (const script of list) {
          for (const key of Object.keys(script)) {
            if (!ALLOWED.has(key)) {
              throw new Error("Error at parameter 'scripts': Error at index 0: Unexpected property: '" + key + "'.");
            }
          }
          if (!Array.isArray(script.js)) {
            throw new Error("Error at parameter 'scripts': Error at index 0: Property 'js' is required.");
          }
          for (const f of script.js) {
            if (!fs.existsSync(path.join(EXT, f))) {
              throw new Error("Error at parameter 'scripts': Error at index 0: Could not load javascript '" + f + "'");
            }
          }
        }
        calls.register.push(list);
        if (cb) { cb(); }
      },
      unregisterContentScripts(opts, cb) {
        calls.unregister.push(opts);
        if (cb) { cb(); return; }
        return Promise.resolve();
      },
      getRegisteredContentScripts(opts, cb) {
        const ids = opts && opts.ids ? opts.ids : [];
        const found = calls.register.length
          ? [{ id: ids[0] }]
          : [];
        if (cb) { cb(found); return; }
        return Promise.resolve(found);
      },
      executeScript(opts, cb) {
        calls.executed.push(opts);
        const results = [{ frameId: 0, result: { zone: 'America/Los_Angeles', hasShim: true, shimZone: 'America/Los_Angeles', now: '2026-01-01T00:00:00.000Z', ua: 'test' } }];
        if (cb) { cb(results); return; }
        return Promise.resolve(results);
      }
    },
    action: {
      setBadgeText(opts, cb) { calls.badge.push(['text', opts.text]); if (cb) cb(); },
      setBadgeBackgroundColor(opts, cb) { calls.badge.push(['color', opts.color]); if (cb) cb(); }
    },
    tabs: {
      create(opts, cb) { calls.created.push(opts.url); if (cb) cb({ id: 1 }); return Promise.resolve({ id: 1 }); },
      get(id, cb) { const tab = { id, url: 'https://chatgpt.com/c/1' }; if (cb) { cb(tab); return; } return Promise.resolve(tab); },
      reload(id, cb) { calls.reloaded.push(id); if (cb) cb(); return Promise.resolve(); },
      query(opts, cb) { if (cb) cb([{ id: 1, url: 'https://chatgpt.com/' }]); return Promise.resolve([]); }
    },
    runtime: {
      lastError: null,
      getManifest() { return { version: '1.0.0' }; },
      getURL(p) { return 'chrome-extension://test/' + p; },
      onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
      onStartup: { addListener(fn) { listeners.startup.push(fn); } },
      onMessage: { addListener(fn) { listeners.message.push(fn); } }
    }
  };
  return { chrome, calls, listeners, getStored: () => stored };
}

function loadBackground(mock, zonesSource) {
  const sandbox = {
    console,
    chrome: mock.chrome,
    setTimeout, clearTimeout,
    URL,
    importScripts(file) {
      const code = fs.readFileSync(path.join(EXT, file), 'utf8');
      vm.runInContext(code, sandbox);
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  return sandbox;
}

/* ---------- 2. background 行为断言 ---------- */

async function testBackground() {
  const mock = createChromeMock(null);
  const sandbox = loadBackground(mock);
  const bg = sandbox.__DSH_TZ_BG__;
  if (!bg) {
    assert('background.js 暴露测试入口', false, '未找到 __DSH_TZ_BG__');
    return;
  }
  assert('background.js 暴露测试入口', true);

  const state = await bg.readState();
  assert('默认状态正确', state.enabled === true && state.zone === 'America/Los_Angeles' && state.scope === 'chatgpt',
    JSON.stringify(state));

  /*
   * background.js 在模块加载时会主动调用 init() 自注册（SW 唤醒自愈）。
   * 这里要等它跑完并把记录清空，否则后面的断言会读到那一次调用。
   */
  await new Promise((resolve) => setTimeout(resolve, 50));
  mock.calls.register.length = 0;
  mock.calls.unregister.length = 0;

  await bg.ensureRegistered(state);
  const reg = mock.calls.register[0] && mock.calls.register[0][0];
  assert('注册了内容脚本', !!reg);
  if (reg) {
    assert('注册 id 正确', reg.id === 'tz-main', reg.id);
    assert('world 为 MAIN', reg.world === 'MAIN', reg.world);
    assert('runAt 为 document_start', reg.runAt === 'document_start', reg.runAt);
    assert('allFrames 开启', reg.allFrames === true, String(reg.allFrames));
    assert('persistAcrossSessions 开启', reg.persistAcrossSessions === true, String(reg.persistAcrossSessions));
    /*
     * 属性名必须是 js（不是 files）。早期这里跟着 mock 一起写成了 files，
     * 导致测试"假绿"——真实 Chrome 会直接拒绝这个参数。
     */
    assert('注入脚本用 js 属性（不是 files）',
      reg.files === undefined, '注册对象里不应出现 files 属性，Chrome 会拒绝：' + JSON.stringify(reg.files));
    assert('文件顺序：zone 文件在伪装脚本之前',
      Array.isArray(reg.js) && reg.js[0] === 'inject/zones/america_los_angeles.js' && reg.js[1] === 'inject/tz-shim.js',
      JSON.stringify(reg.js));
    assert('ChatGPT 范围的 matches 正确',
      Array.isArray(reg.matches) && reg.matches.indexOf('https://chatgpt.com/*') >= 0 && reg.matches.indexOf('https://*.openai.com/*') >= 0,
      JSON.stringify(reg.matches));
  }

  // 关闭后只反注册
  const before = mock.calls.register.length;
  const okOff = await bg.ensureRegistered({ enabled: false, zone: 'Asia/Tokyo', scope: 'all', v: 1 });
  assert('关闭时不注册', mock.calls.register.length === before && okOff === false);

  // scope=all
  await bg.ensureRegistered({ enabled: true, zone: 'Asia/Tokyo', scope: 'all', v: 1 });
  const regAll = mock.calls.register[mock.calls.register.length - 1][0];
  assert('所有网站范围使用 <all_urls>', regAll.matches.length === 1 && regAll.matches[0] === '<all_urls>', JSON.stringify(regAll.matches));
  assert('切换时区后注入文件同步变化', regAll.js[0] === 'inject/zones/asia_tokyo.js', JSON.stringify(regAll.js));

  /*
   * WebRTC 防护是可选项：关闭时注入列表只有 2 个文件，
   * 打开时中间多一个 inject/webrtc-guard.js，且必须排在 tz-shim 之前。
   */
  assert('默认关闭 WebRTC 防护（注入 2 个文件）',
    regAll.js.length === 2 && regAll.js.indexOf('inject/webrtc-guard.js') < 0,
    JSON.stringify(regAll.js));

  await bg.ensureRegistered({ enabled: true, zone: 'America/Los_Angeles', scope: 'chatgpt', webrtc: true, v: 1 });
  const regWrtc = mock.calls.register[mock.calls.register.length - 1][0];
  assert('开启 WebRTC 后注入 3 个文件',
    regWrtc.js.length === 3 && regWrtc.js.indexOf('inject/webrtc-guard.js') === 1,
    JSON.stringify(regWrtc.js));
  assert('WebRTC 脚本排在 tz-shim 之前',
    regWrtc.js[1] === 'inject/webrtc-guard.js' && regWrtc.js[2] === 'inject/tz-shim.js',
    JSON.stringify(regWrtc.js));

  // 校验
  assert('拒绝非法时区', !!bg.validatePatch({ zone: 'Not/AZone' }));
  assert('拒绝非法范围', !!bg.validatePatch({ scope: 'nope' }));
  assert('拒绝非布尔开关', !!bg.validatePatch({ enabled: 'yes' }));
  assert('接受合法 patch', bg.validatePatch({ enabled: true, zone: 'Europe/London', scope: 'all' }) === null);

  // 消息分支
  const getState = await bg.handleMessage({ type: 'getState' }, {});
  assert('getState 返回状态与 meta', getState.ok && getState.state && getState.meta && typeof getState.meta.realZone === 'string');

  const setState = await bg.handleMessage({ type: 'setState', patch: { zone: 'Europe/London' } }, {});
  assert('setState 生效', setState.ok && setState.state.zone === 'Europe/London', JSON.stringify(setState));

  const badPatch = await bg.handleMessage({ type: 'setState', patch: { zone: 'Bad/Zone' } }, {});
  assert('setState 拒绝非法时区', badPatch.ok === false && typeof badPatch.error === 'string');

  const checkTab = await bg.handleMessage({ type: 'checkTab', tabId: 7 }, {});
  assert('checkTab 走 executeScript 且返回时区', checkTab.ok && checkTab.result && checkTab.result.zone === 'America/Los_Angeles',
    JSON.stringify(checkTab));
  const exec = mock.calls.executed[mock.calls.executed.length - 1];
  assert('checkTab 在 MAIN world 执行', exec && exec.world === 'MAIN' && exec.target.tabId === 7);

  const badTab = await bg.handleMessage({ type: 'checkTab', tabId: 'abc' }, {});
  assert('checkTab 拒绝非法 tabId', badTab.ok === false);

  const reload = await bg.handleMessage({ type: 'reloadTab', tabId: 7 }, {});
  assert('reloadTab 调用 chrome.tabs.reload', reload.ok && mock.calls.reloaded.indexOf(7) >= 0);

  const openChatGPT = await bg.handleMessage({ type: 'openChatGPT' }, {});
  assert('openChatGPT 打开 chatgpt.com', openChatGPT.ok && mock.calls.created.indexOf('https://chatgpt.com/') >= 0);

  const openVerify = await bg.handleMessage({ type: 'openVerify' }, {});
  assert('openVerify 打开自检页', openVerify.ok && mock.calls.created.some((u) => u.indexOf('verify/verify.html') >= 0),
    JSON.stringify(mock.calls.created));

  const unknown = await bg.handleMessage({ type: 'nope' }, {});
  assert('未知消息被拒绝', unknown.ok === false);

  // 消息监听器必须 return true（异步 sendResponse）
  const listener = mock.listeners.message[0];
  if (listener) {
    let responded = null;
    const returned = listener({ type: 'getState' }, {}, (r) => { responded = r; });
    assert('onMessage 返回 true 以支持异步响应', returned === true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert('onMessage 异步回包', !!responded && responded.ok === true);
  } else {
    assert('注册了 onMessage 监听器', false);
  }

  // onInstalled install 分支会打开 ChatGPT
  mock.calls.created.length = 0;
  mock.listeners.installed.forEach((fn) => fn({ reason: 'install' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert('首次安装后自动打开 ChatGPT', mock.calls.created.indexOf('https://chatgpt.com/') >= 0, JSON.stringify(mock.calls.created));

  // 徽标
  assert('启用时设置徽标', mock.calls.badge.some((b) => b[0] === 'text' && b[1] === 'TZ'), JSON.stringify(mock.calls.badge));
}

/* ---------- 3. manifest / 静态引用 ---------- */

function testManifest() {
  const manifestPath = path.join(EXT, 'manifest.json');
  assert('manifest.json 存在', fs.existsSync(manifestPath));
  if (!fs.existsSync(manifestPath)) return;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert('manifest.json 是合法 JSON', true);
  } catch (e) {
    assert('manifest.json 是合法 JSON', false, e.message);
    return;
  }

  assert('manifest_version 为 3', manifest.manifest_version === 3);
  assert('background.service_worker 存在', !!manifest.background && !!manifest.background.service_worker);
  assert('service_worker 文件存在', existsExt(manifest.background.service_worker));
  assert('action.default_popup 存在', existsExt(manifest.action.default_popup));

  ['16', '32', '48', '128'].forEach((size) => {
    assert('图标 ' + size + 'px 存在', existsExt((manifest.icons || {})[size] || ''));
  });

  const perms = manifest.permissions || [];
  assert('permissions 含 storage', perms.indexOf('storage') >= 0);
  assert('permissions 含 scripting', perms.indexOf('scripting') >= 0);
  assert('host_permissions 含 <all_urls>', (manifest.host_permissions || []).indexOf('<all_urls>') >= 0);

  const war = manifest.web_accessible_resources || [];
  const resources = war.reduce((acc, item) => acc.concat(item.resources || []), []);
  ['verify/verify.html', 'verify/verify.js', 'verify/verify-bootstrap.html', 'inject/tz-shim.js']
    .forEach((r) => assert('web_accessible_resources 含 ' + r, resources.indexOf(r) >= 0));

  // inject 目录完整性
  assert('inject/tz-shim.js 存在', existsExt('inject/tz-shim.js'));
  assert('inject/zones 目录存在', fs.existsSync(path.join(EXT, 'inject/zones')));
  const zoneFiles = fs.existsSync(path.join(EXT, 'inject/zones')) ? fs.readdirSync(path.join(EXT, 'inject/zones')) : [];
  assert('时区文件数量正常', zoneFiles.length > 100, String(zoneFiles.length));

  // popup 引用的资源
  const popupHtml = readExt('popup/popup.html');
  const popupRefs = [];
  popupHtml.replace(/(?:src|href)="([^"]+)"/g, (m, p) => { popupRefs.push(p); });
  popupRefs.filter((p) => !/^https?:/.test(p)).forEach((p) => {
    const rel = path.normalize(path.join('popup', p)).replace(/\\/g, '/');
    assert('popup 引用存在：' + rel, existsExt(rel));
  });
  assert('popup.html 无内联脚本', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(popupHtml));

  // verify 页引用的资源
  const verifyHtml = readExt('verify/verify.html');
  const verifyRefs = [];
  verifyHtml.replace(/(?:src|href)="([^"]+)"/g, (m, p) => { verifyRefs.push(p); });
  verifyRefs.filter((p) => !/^https?:/.test(p)).forEach((p) => {
    const rel = path.normalize(path.join('verify', p)).replace(/\\/g, '/');
    assert('verify 引用存在：' + rel, existsExt(rel));
  });
  assert('verify.html 无内联脚本', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(verifyHtml));
}

/* ---------- 4. popup.js 的 DOM id 与 html 一致性 ---------- */

function testPopupIds() {
  const html = readExt('popup/popup.html');
  const js = readExt('popup/popup.js');
  const htmlIds = new Set();
  html.replace(/id="([^"]+)"/g, (m, id) => { htmlIds.add(id); });

  const used = new Set();
  js.replace(/getElementById\('([^']+)'\)/g, (m, id) => { used.add(id); });
  js.replace(/\$\('([^']+)'\)/g, (m, id) => { used.add(id); });

  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert('popup.js 引用的 DOM id 都存在', missing.length === 0, '缺少：' + missing.join(', '));
  assert('popup.js 至少引用了 15 个节点', used.size >= 15, String(used.size));
}

/* ---------- 5. 语法检查 ---------- */

function testSyntax() {
  const targets = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) targets.push(p);
    });
  })(EXT);

  /*
   * 用 vm.Script 做进程内语法检查。
   * 早期实现是给每个文件 spawn 一次 node --check，419 个 zones 文件 + 其它共 426 次 spawn，
   * 在受限环境里会直接卡死。
   */
  const bad = [];
  targets.forEach((file) => {
    try {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    } catch (err) {
      bad.push(path.relative(EXT, file) + ': ' + (err && err.message));
    }
  });
  assert('所有 JS 文件语法正确（' + targets.length + ' 个）', bad.length === 0, bad.slice(0, 5).join(', '));
}

/* ---------- main ---------- */

async function main() {
  testManifest();
  testPopupIds();
  testSyntax();
  await testBackground();

  process.stdout.write('== 扩展外壳测试 ==\n');
  notes.forEach((n) => process.stdout.write(n + '\n'));

  if (failures.length) {
    process.stdout.write('\n✗ 失败 ' + failures.length + ' 项：\n');
    failures.forEach((f) => process.stdout.write('  - ' + f + '\n'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✓ 全部通过（' + notes.length + ' 项断言）\n');
}

main().catch((e) => {
  process.stdout.write('✗ 测试异常：' + (e && e.stack || e) + String.fromCharCode(10));
  process.stdout.write('--- 已完成断言 ---' + String.fromCharCode(10));
  notes.forEach((n) => process.stdout.write(n + String.fromCharCode(10)));
  process.exitCode = 1;
});
