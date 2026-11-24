#!/usr/bin/env node
/*
 * tests/ip-zone-map.test.cjs —— 出口 IP → 时区映射校验
 *
 * 背景：社区反馈「时区必须和出口 IP 一致」，所以扩展提供了「跟随代理」功能。
 * 这个测试保证 COUNTRY_ZONE 里的每个时区都真实存在于 zones 目录，
 * 否则用户点「跟随代理」会设置一个不存在的时区。
 *
 * 用法：node tests/ip-zone-map.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log('  ✓ ' + name);
    pass++;
  } else {
    console.log('  ✗ ' + name + (detail ? '  ' + detail : ''));
    fail++;
  }
}

/* ---------- 加载真实时区目录 ---------- */
const zoneSandbox = {};
zoneSandbox.globalThis = zoneSandbox;
vm.createContext(zoneSandbox);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'extension/shared/zones.js'), 'utf8'),
  zoneSandbox,
  { filename: 'zones.js' }
);
const catalog = zoneSandbox.DSH_TZ_ZONES.map(function (z) { return z.zone; });

/* ---------- 从 shared/geo-zones.js 读取映射 ---------- */
const geo = require(path.join(ROOT, 'extension/shared/geo-zones.js'));
const countryZone = geo.COUNTRY_ZONE;
if (!countryZone || typeof countryZone !== 'object') {
  console.log('✗ shared/geo-zones.js 没有导出 COUNTRY_ZONE');
  process.exit(1);
}

console.log('== 出口 IP → 时区映射测试 ==');
console.log('');

const codes = Object.keys(countryZone);
check('映射表非空（' + codes.length + ' 个地区）', codes.length >= 30);

console.log('');
console.log('--- 每个映射的时区必须存在于目录 ---');
const invalid = [];
codes.forEach(function (code) {
  const zone = countryZone[code];
  if (catalog.indexOf(zone) < 0) invalid.push(code + ' → ' + zone);
});
check('全部 ' + codes.length + ' 个映射有效', invalid.length === 0, invalid.join(', '));

console.log('');
console.log('--- 关键地区抽查 ---');
const expected = {
  US: 'America/Los_Angeles',
  JP: 'Asia/Tokyo',
  SG: 'Asia/Singapore',
  GB: 'Europe/London',
  DE: 'Europe/Berlin',
  HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei',
  KR: 'Asia/Seoul',
  AU: 'Australia/Sydney',
  CN: 'Asia/Shanghai'
};
Object.keys(expected).forEach(function (code) {
  check(code + ' → ' + expected[code], countryZone[code] === expected[code], '实际: ' + countryZone[code]);
});

console.log('');
console.log('--- 目录里应包含这些常用时区 ---');
['Asia/Tokyo', 'America/New_York', 'Europe/London', 'Asia/Singapore'].forEach(function (z) {
  check('目录含 ' + z, catalog.indexOf(z) >= 0);
});

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail === 0 ? 0 : 1;
