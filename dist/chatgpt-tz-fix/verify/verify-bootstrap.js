/*
 * verify-bootstrap.js —— 自检用的「被测页面环境」引导脚本。
 *
 * verify.html 会以 ?zone=<IANA>&slug=<slug> 的方式内嵌本页面；本脚本按顺序注入：
 *   1) inject/zones/<slug>.js   —— 与真实内容脚本相同的 zone 变量文件
 *   2) inject/tz-shim.js        —— 与真实内容脚本完全相同的伪装脚本
 *   3) verify-fingerprint.js    —— 观测采集器
 * 注入完成后设置 window.__TZF_READY__ 供宿主页面轮询。
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var zone = params.get('zone') || '';
  var slug = params.get('slug') || '';

  function fail(reason) {
    globalThis.__TZF_READY__ = { ok: false, error: String(reason) };
  }

  if (!zone || !slug) {
    fail('缺少 zone/slug 参数');
    return;
  }

  /*
   * slug 会被拼进 script.src，必须严格限定字符集，
   * 否则 ?slug=../../foo 之类可以构造路径穿越（虽然受 web_accessible_resources
   * 白名单限制，仍不应留下这个口子）。
   */
  if (!/^[a-z0-9_]{1,64}$/.test(slug)) {
    fail('非法的 slug 参数');
    return;
  }

  var pending = ['../inject/zones/' + slug + '.js', '../inject/tz-shim.js', 'verify-fingerprint.js'];
  var index = 0;

  function next() {
    if (index >= pending.length) {
      globalThis.__TZF_READY__ = {
        ok: true,
        zone: zone,
        slug: slug,
        shim: globalThis.__DSH_TZ_FIX__ || null,
        zoneVar: globalThis.__DSH_TZ_FIX_ZONE__ || null
      };
      return;
    }
    var src = pending[index];
    index += 1;
    var el = document.createElement('script');
    el.src = src;
    el.onload = function () { next(); };
    el.onerror = function () { fail('脚本加载失败: ' + src); };
    (document.head || document.documentElement).appendChild(el);
  }

  next();
})();
