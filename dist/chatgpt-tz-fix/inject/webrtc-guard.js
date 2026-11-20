/*
 * ⚠ 本文件由 tools/build.cjs 从 src/webrtc-guard.js 自动生成，请勿直接修改。
 * 修改请编辑 src/webrtc-guard.js 后重新运行：node tools/build.cjs
 */
/*
 * webrtc-guard.js —— WebRTC 本机 IP 防泄露
 *
 * 背景
 *   WebRTC 在建立连接前会收集「候选地址」，其中 typ host / typ srflx 携带的是
 *   本机网卡地址和 NAT 映射地址。某些情况下（尤其是 UDP 直连、或代理不支持 UDP 转发时）
 *   这些地址是**真实公网 IP**，会绕过代理直接暴露给页面 JS。
 *   网站只要列一遍 candidates 就能拿到它，用来和出口 IP 比对做风控。
 *
 * 我们做什么
 *   只过滤「页面 JS 能看到的东西」，不动浏览器内部的连接过程：
 *     1. onicecandidate / addEventListener('icecandidate') 里丢弃 host / srflx 候选
 *     2. localDescription / currentLocalDescription / pendingLocalDescription
 *        的 SDP 里剔除对应 a=candidate 行
 *
 * 为什么这样做是安全的
 *   候选地址的收集与连接发生在浏览器内部，过滤事件**不影响真实连接**。
 *   正常的视频通话、P2P 应用照样能连（它们靠的是内部候选表，不是页面 JS 读到的列表），
 *   只是页面拿不到能定位你真实 IP 的候选了。
 *
 * 与强制中继（iceTransportPolicy: 'relay'）的区别
 *   强制中继会让所有流量走 TURN，如果没有可用 TURN 服务器，WebRTC 直接不可用
 *   （视频通话会挂）。过滤模式没有这个副作用，所以默认用它。
 */
(function () {
  'use strict';

  var MARK = '__DSH_WEBRTC_GUARD__';
  if (globalThis[MARK]) return;   // 已安装

  var RealRTC = globalThis.RTCPeerConnection || globalThis.webkitRTCPeerConnection;
  if (typeof RealRTC !== 'function') {
    // 浏览器没有 WebRTC，无需处理
    try {
      Object.defineProperty(globalThis, MARK, {
        value: Object.freeze({ installed: false, reason: 'no-webrtc' }),
        writable: false, configurable: false, enumerable: false
      });
    } catch (err) { /* 忽略 */ }
    return;
  }

  /** 判断一个候选是否是「会泄露真实 IP」的类型。仅 relay 是安全的。 */
  function isLeakyCandidate(candidate) {
    if (!candidate) return false;
    var text = typeof candidate === 'string' ? candidate : (candidate.candidate || '');
    if (!text) return false;
    // typ host：本机网卡地址；typ srflx：NAT 映射后的公网地址
    return /\btyp\s+(host|srflx)\b/i.test(text);
  }

  /** 过滤 ICE candidate 事件：中继（typ relay）放行，其余丢弃 */
  function filterCandidateEvent(event) {
    if (!event) return true;
    try {
      if (isLeakyCandidate(event.candidate)) return false;
    } catch (err) { /* 忽略异常，按原样放行 */ }
    return true;
  }

  /** 包装 onicecandidate 赋值用的回调 */
  function wrapHandler(handler) {
    if (typeof handler !== 'function') return handler;
    return function (event) {
      if (!filterCandidateEvent(event)) return undefined;
      return handler.apply(this, arguments);
    };
  }

  /** 包装 addEventListener 传入的 listener（函数或 handleEvent 对象） */
  function wrapListener(listener) {
    if (!listener) return listener;
    if (typeof listener === 'function') {
      return function (event) {
        if (!filterCandidateEvent(event)) return undefined;
        return listener.apply(this, arguments);
      };
    }
    if (typeof listener.handleEvent === 'function') {
      return {
        handleEvent: function (event) {
          if (!filterCandidateEvent(event)) return undefined;
          return listener.handleEvent.call(listener, event);
        }
      };
    }
    return listener;
  }

  /* -------------------------------------------------------- SDP 清洗 */

  /** 从 SDP 里剔除 host / srflx 的 a=candidate 行 */
  function sanitizeSdp(sdp) {
    if (typeof sdp !== 'string' || sdp.indexOf('a=candidate') < 0) return sdp;
    return sdp
      .split(/\r\n/)
      .filter(function (line) {
        if (line.indexOf('a=candidate') !== 0) return true;
        return !/\btyp\s+(host|srflx)\b/i.test(line);
      })
      .join('\r\n');
  }

  /** 把某个 RTCSessionDescription-ish 对象的 sdp 清洗掉（保留原类型与其它字段） */
  function sanitizeDescription(desc) {
    if (!desc) return desc;
    try {
      var clean = sanitizeSdp(desc.sdp);
      if (clean === desc.sdp) return desc;

      var proto = Object.getPrototypeOf(desc);
      var copy = Object.create(proto);
      Object.keys(desc).forEach(function (k) {
        try { copy[k] = desc[k]; } catch (err) { /* 忽略 */ }
      });
      // 重新定义 sdp 为清洗后的值
      try {
        Object.defineProperty(copy, 'sdp', {
          value: clean, writable: false, enumerable: true, configurable: true
        });
      } catch (err) {
        copy.sdp = clean;
      }
      return copy;
    } catch (err) {
      return desc;
    }
  }

  /* ------------------------------------------------- 实例级事件拦截 */

  var proto = RealRTC.prototype;
  var nativeOnIceDesc = null;
  try {
    nativeOnIceDesc = Object.getOwnPropertyDescriptor(proto, 'onicecandidate');
  } catch (err) { nativeOnIceDesc = null; }

  var nativeAddEventListener = proto.addEventListener;
  var nativeRemoveEventListener = proto.removeEventListener;

  /**
   * 给实例加上候选过滤（每个实例只装一次）。
   *
   * 核心思路：不管页面用 onicecandidate 还是 addEventListener，
   * 最终都会走到「事件派发」这一步。所以最可靠的做法是同时接管两者：
   *   · 实例上的 onicecandidate：装 accessor，赋值时自动包过滤
   *   · 实例上的 addEventListener：包装 icecandidate 的 listener
   *
   * 只接管 onicecandidate 不够——有些实现把它当普通字段，
   * 浏览器内部派发时直接调用该字段，会绕过我们的 accessor。
   */
  function hardenInstance(pc) {
    if (!pc || pc.__dshHardened) return pc;
    try {
      Object.defineProperty(pc, '__dshHardened', {
        value: true, writable: false, enumerable: false, configurable: false
      });
    } catch (err) { /* 忽略 */ }

    // ---- 1) 接管 onicecandidate ----
    try {
      var currentHandler = null;
      var storeRaw = null;

      if (nativeOnIceDesc && typeof nativeOnIceDesc.set === 'function') {
        storeRaw = function (fn) { nativeOnIceDesc.set.call(pc, fn); };
      } else {
        // 没有原生 accessor：自己在实例上存
        Object.defineProperty(pc, '__dshRawIce', {
          value: null, writable: true, enumerable: false, configurable: true
        });
        storeRaw = function (fn) { pc.__dshRawIce = fn; };
      }

      Object.defineProperty(pc, 'onicecandidate', {
        configurable: true,
        enumerable: true,
        get: function () { return currentHandler; },
        set: function (fn) {
          currentHandler = (typeof fn === 'function') ? fn : null;
          storeRaw(currentHandler ? wrapHandler(currentHandler) : null);
        }
      });
    } catch (err) { /* 忽略 */ }

    // ---- 2) 接管 addEventListener ----
    try {
      Object.defineProperty(pc, 'addEventListener', {
        configurable: true, writable: true, enumerable: false,
        value: function (type, listener, options) {
          var useListener = (type === 'icecandidate') ? wrapListener(listener) : listener;
          return nativeAddEventListener.call(this, type, useListener, options);
        }
      });
      Object.defineProperty(pc, 'removeEventListener', {
        configurable: true, writable: true, enumerable: false,
        value: function (type, listener, options) {
          return nativeRemoveEventListener.call(this, type, listener, options);
        }
      });
    } catch (err) { /* 忽略 */ }

    return pc;
  }

  /* ------------------------------------------------- 原型级 SDP 拦截 */

  [
    'localDescription',
    'currentLocalDescription',
    'pendingLocalDescription'
  ].forEach(function (prop) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.get !== 'function') return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return sanitizeDescription(desc.get.call(this));
        }
      });
    } catch (err) { /* 忽略 */ }
  });

  /* ------------------------------------------------------- 替换构造函数 */

  var GuardedRTCPeerConnection = new Proxy(RealRTC, {
    construct: function (target, argsList, newTarget) {
      // 默认不强制中继：保持正常连通性，只在事件与 SDP 层面做过滤
      var pc = Reflect.construct(target, argsList, newTarget);
      return hardenInstance(pc);
    }
  });

  try {
    Object.defineProperty(GuardedRTCPeerConnection, 'name', {
      value: 'RTCPeerConnection', configurable: true
    });
  } catch (err) { /* 忽略 */ }

  try {
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      value: GuardedRTCPeerConnection,
      writable: true,
      configurable: true,
      enumerable: false
    });
    if ('webkitRTCPeerConnection' in globalThis) {
      Object.defineProperty(globalThis, 'webkitRTCPeerConnection', {
        value: GuardedRTCPeerConnection,
        writable: true,
        configurable: true,
        enumerable: false
      });
    }
  } catch (err) {
    console.warn('[DSH WebRTC Guard] 安装失败：' + (err && err.message));
  }

  try {
    Object.defineProperty(globalThis, MARK, {
      value: Object.freeze({ installed: true, mode: 'filter', at: Date.now() }),
      writable: false, configurable: false, enumerable: false
    });
  } catch (err) { /* 忽略 */ }
})();
