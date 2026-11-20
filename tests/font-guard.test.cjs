#!/usr/bin/env node
/*
 * tests/font-guard.test.cjs —— 中文字体指纹模糊测试
 *
 * 检测站点靠两种方式判断你是否在中国环境：
 *   1. document.fonts.check('12px SimHei')
 *   2. Canvas measureText 比对字体回退宽度
 * 这个测试用一个"假装装了中文字体"的假环境，验证两种探测都被拦住。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'extension/inject/font-guard.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); fail++; }
}

/* ---------- 造一个假浏览器环境 ---------- */

/* 假 FontFaceSet：check() 对所有已知中文字体返回 true（模拟 Windows 中文系统） */
const installedFonts = new Set([
  'simhei', 'simsun', 'kaiti', 'fangsong', 'microsoft yahei',
  '宋体', '黑体', '楷体', '仿宋', '微软雅黑', 'dengxian'
]);

const fakeFonts = {
  check(spec) {
    // 从 "12px SimHei" 里提取字体名
    const m = /(?:^|\s)(?:"([^"]+)"|'([^']+)'|([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .-]*))\s*$/.exec(String(spec));
    const name = m ? (m[1] || m[2] || m[3] || '').trim().toLowerCase() : '';
    return installedFonts.has(name);
  }
};

/* 假 Canvas：measureText 按字体名返回不同宽度，模拟真实回退行为 */
function makeCanvasProto() {
  function Ctx() { this._font = '10px sans-serif'; }
  Object.defineProperty(Ctx.prototype, 'font', {
    get() { return this._font; },
    set(v) {
      if (Math.random() < 0) throw new Error('noop');
      this._font = v;
    },
    configurable: true
  });
  Ctx.prototype.measureText = function (text) {
    const len = String(text).length;
    const f = String(this._font).toLowerCase();
    // 命中中文字体 → 更宽（模拟字形差异）
    const cn = /simhei|simsun|kaiti|fangsong|yahei|宋体|黑体|楷体|仿宋|雅黑/.test(f);
    return { width: len * (cn ? 9.5 : 7.0) };
  };
  return Ctx.prototype;
}

const sandbox = {
  console,
  document: { fonts: fakeFonts },
  CanvasRenderingContext2D: function CanvasRenderingContext2D() {},
  Object, Reflect, String, Array, TypeError
};
sandbox.CanvasRenderingContext2D.prototype = makeCanvasProto();
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------- 基线：加载前能探测到中文字体 ---------- */
console.log('== 字体指纹模糊测试 ==');
console.log('');
console.log('--- 基线（加载防护前，模拟中文 Windows）---');
const beforeCheck = sandbox.document.fonts.check('12px "SimHei"');
const beforeCheckYh = sandbox.document.fonts.check('12px "Microsoft YaHei"');
const ctx0 = new sandbox.CanvasRenderingContext2D();
ctx0.font = '12px monospace, SimHei';
const wWith = ctx0.measureText('mmmmmmmmmmlli').width;
ctx0.font = '12px monospace';
const wWithout = ctx0.measureText('mmmmmmmmmmlli').width;
check('基线：能探测到 SimHei', beforeCheck === true);
check('基线：能探测到微软雅黑', beforeCheckYh === true);
check('基线：Canvas 能区分字体（宽度不同）', wWith !== wWithout, wWith + ' vs ' + wWithout);

/* ---------- 加载防护 ---------- */
console.log('');
console.log('--- 加载 font-guard.js ---');
vm.runInContext(fs.readFileSync(GUARD, 'utf8'), sandbox, { filename: 'font-guard.js' });
const mark = sandbox.__DSH_FONT_GUARD__;
check('防护已安装', !!(mark && mark.installed), JSON.stringify(mark));

/* ---------- 验证探测被拦 ---------- */
console.log('');
console.log('--- 防护后：document.fonts.check ---');
check('SimHei 探测为 false', sandbox.document.fonts.check('12px SimHei') === false);
check('宋体 探测为 false', sandbox.document.fonts.check('12px 宋体') === false);
check('微软雅黑 探测为 false', sandbox.document.fonts.check('12px "Microsoft YaHei"') === false);
check('KaiTi 探测为 false', sandbox.document.fonts.check("12px 'KaiTi'") === false);
check('非中文字体不受影响（Arial 仍可查）',
  sandbox.document.fonts.check('12px Arial') === installedFonts.has('arial'));

console.log('');
console.log('--- 防护后：Canvas measureText ---');
const ctx = new sandbox.CanvasRenderingContext2D();
ctx.font = '12px monospace, SimHei';
const w1 = ctx.measureText('mmmmmmmmmmlli').width;
ctx.font = '12px monospace';
const w2 = ctx.measureText('mmmmmmmmmmlli').width;
check('带 SimHei 与不带宽度一致', w1 === w2, w1 + ' vs ' + w2);
check('font 属性测完已还原', ctx.font === '12px monospace', JSON.stringify(ctx.font));

console.log('');
console.log('--- 不影响正常字体 ---');
const ctx2 = new sandbox.CanvasRenderingContext2D();
ctx2.font = '12px Arial, sans-serif';
const wa = ctx2.measureText('hello').width;
check('非中文字体测量正常', wa > 0, String(wa));

console.log('');
console.log('--- 幂等 ---');
const m1 = sandbox.__DSH_FONT_GUARD__;
vm.runInContext(fs.readFileSync(GUARD, 'utf8'), sandbox, { filename: 'font-guard-2.js' });
check('重复加载幂等', sandbox.__DSH_FONT_GUARD__ === m1);

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail === 0 ? 0 : 1;
