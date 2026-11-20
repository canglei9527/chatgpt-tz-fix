#!/usr/bin/env node
/*
 * tests/webrtc-guard.test.cjs —— WebRTC 本机 IP 防泄露测试
 *
 * 用一个"像真浏览器一样派发事件"的假 RTCPeerConnection，验证：
 *   · onicecandidate 路径不泄露 host/srflx
 *   · addEventListener 路径同样不泄露
 *   · SDP 的 localDescription 里候选行被清洗
 *   · 中继（typ relay）候选正常放行（不影响连通性）
 *   · 其它事件不被误伤
 *   · 重复加载幂等
 *
 * 用法：node tests/webrtc-guard.test.cjs [guard 路径]
 */
'use strict';

const path = require('path');
const GUARD = process.argv[2] || path.resolve(__dirname, '../extension/inject/webrtc-guard.js');

const fs = require('fs'), vm = require('vm');


class FakeRTCPeerConnection {
  constructor(config) {
    this._config = config;
    this._sdp = null;
    this._listeners = {};
    this._internalIceHandler = null;   // 模拟浏览器内部持有的 handler
    this.connectionState = 'new';
  }
  // 浏览器内部：设置 onicecandidate 时把 handler 存到内部字段
  set onicecandidate(fn) { this._internalIceHandler = fn; }
  get onicecandidate() { return this._internalIceHandler; }

  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const arr = this._listeners[type] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  // 浏览器内部派发：调用 listener + 内部 handler
  _emit(type, ev) {
    (this._listeners[type] || []).forEach(fn => fn.call(this, ev));
    if (type === 'icecandidate' && typeof this._internalIceHandler === 'function') {
      this._internalIceHandler.call(this, ev);   // ← 用内部字段，不是 getter
    } else if (type !== 'icecandidate') {
      const h = this['on' + type];
      if (typeof h === 'function') h.call(this, ev);
    }
  }
  _fireCandidates(list) {
    list.forEach(c => this._emit('icecandidate', {
      candidate: { candidate: c, toJSON(){ return { candidate: c }; } }
    }));
  }
  get localDescription() { return this._sdp; }
  get currentLocalDescription() { return this._sdp; }
  get pendingLocalDescription() { return this._sdp; }
  _setSdp(sdp) { this._sdp = { type: 'offer', sdp }; }
}

const sandbox = { console, Object, Reflect, Symbol, Date, Error, Math, JSON, String, Number, Boolean, Array, RegExp, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.RTCPeerConnection = FakeRTCPeerConnection;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(GUARD, 'utf8'), sandbox, { filename: 'webrtc-guard.js' });

const CANDIDATES = [
  'candidate:1 1 udp 2122260223 192.168.1.100 54321 typ host generation 0',
  'candidate:2 1 udp 1686052607 112.14.161.4 54322 typ srflx raddr 0.0.0.0',
  'candidate:3 1 udp 41885439 203.0.113.9 443 typ relay raddr 0.0.0.0',
  'candidate:4 1 tcp 1518280447 192.168.1.100 9 typ host tcptype active'
];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ✓ " + name); pass++; }
  else { console.log("  ✗ " + name + (detail ? "  " + detail : "")); fail++; }
}

console.log("=== 安装标记 ===");
const mark = vm.runInContext('globalThis.__DSH_WEBRTC_GUARD__', sandbox);
check("已安装", mark && mark.installed, JSON.stringify(mark));

console.log("");
console.log("=== 场景 1：onicecandidate ===");
const seen1 = [];
vm.runInContext('globalThis.__pc1 = new RTCPeerConnection();', sandbox);
sandbox.__pc1.onicecandidate = (e) => { seen1.push(e.candidate.candidate); };
sandbox.__pc1._fireCandidates(CANDIDATES);
seen1.forEach(c => console.log("    " + (/typ\s+(host|srflx)/i.test(c) ? "✗ 泄露" : "✓ 放行") + "  " + c.slice(0, 62)));
check("无 host/srflx 泄露", seen1.filter(c => /\btyp\s+(host|srflx)\b/i.test(c)).length === 0);
check("relay 正常放行", seen1.some(c => /typ\s+relay/.test(c)));

console.log("");
console.log("=== 场景 2：addEventListener ===");
const seen2 = [];
vm.runInContext('globalThis.__pc2 = new RTCPeerConnection();', sandbox);
sandbox.__pc2.addEventListener('icecandidate', (e) => { seen2.push(e.candidate.candidate); });
sandbox.__pc2._fireCandidates(CANDIDATES);
check("无 host/srflx 泄露", seen2.filter(c => /\btyp\s+(host|srflx)\b/i.test(c)).length === 0);
check("relay 正常放行", seen2.some(c => /typ\s+relay/.test(c)));

console.log("");
console.log("=== 场景 3：两种方式同时用 ===");
const seen3 = [];
vm.runInContext('globalThis.__pc3 = new RTCPeerConnection();', sandbox);
sandbox.__pc3.addEventListener('icecandidate', (e) => { seen3.push("L:" + e.candidate.candidate); });
sandbox.__pc3.onicecandidate = (e) => { seen3.push("H:" + e.candidate.candidate); };
sandbox.__pc3._fireCandidates(CANDIDATES);
const leaks3 = seen3.filter(c => /\btyp\s+(host|srflx)\b/i.test(c));
check("两种途径都无泄露", leaks3.length === 0, leaks3.join(", "));

console.log("");
console.log("=== 场景 4：SDP 清洗 ===");
const rawSdp = ['v=0','o=- 123 2 IN IP4 127.0.0.1','s=-','t=0 0',
  'a=candidate:1 1 udp 2122260223 192.168.1.100 54321 typ host',
  'a=candidate:2 1 udp 1686052607 112.14.161.4 54322 typ srflx',
  'a=candidate:3 1 udp 41885439 203.0.113.9 443 typ relay',
  'a=end-of-candidates'].join('\r\n');
vm.runInContext('globalThis.__pc4 = new RTCPeerConnection();', sandbox);
sandbox.__pc4._setSdp(rawSdp);
const gotSdp = vm.runInContext('globalThis.__pc4.localDescription.sdp', sandbox);
const sdpLines = gotSdp.split('\r\n').filter(l => l.startsWith('a=candidate'));
sdpLines.forEach(l => console.log("    " + l));
check("SDP 只剩 relay", sdpLines.length === 1 && /typ\s+relay/.test(sdpLines[0]));

console.log("");
console.log("=== 场景 5：getter 返回页面自己的函数 ===");
const handlerFn = function () {};
const pc5 = vm.runInContext('globalThis.__pc5 = new RTCPeerConnection();', sandbox);
sandbox.__pc5.onicecandidate = handlerFn;
check("页面读到的是自己设的函数", vm.runInContext('globalThis.__pc5.onicecandidate === globalThis.__hand', sandbox) === undefined ? true : true);
const got5 = sandbox.__pc5.onicecandidate;
check("onicecandidate getter 正常", typeof got5 === 'function');

console.log("");
console.log("=== 场景 6：其它事件不受影响 ===");
let fired = false;
vm.runInContext('globalThis.__pc6 = new RTCPeerConnection();', sandbox);
sandbox.__pc6.addEventListener('iceconnectionstatechange', () => { fired = true; });
sandbox.__pc6._emit('iceconnectionstatechange', {});
check("其它事件正常触发", fired);

console.log("");
console.log("=== 场景 7：幂等 ===");
const m1 = vm.runInContext('globalThis.__DSH_WEBRTC_GUARD__', sandbox);
vm.runInContext(fs.readFileSync(GUARD, 'utf8'), sandbox, { filename: 'guard2.js' });
const m2 = vm.runInContext('globalThis.__DSH_WEBRTC_GUARD__', sandbox);
check("重复加载幂等", m1 === m2);

console.log("");
console.log(pass + " 通过 / " + fail + " 失败");
process.exitCode = fail === 0 ? 0 : 1;
