#!/usr/bin/env node
/**
 * tools/gen-zones.cjs
 * 生成扩展所需的时区数据：
 *   - extension/inject/zones/<slug>.js   每个时区一个小文件（单行，注入到页面 MAIN world）
 *   - extension/shared/zones.js          时区目录（globalThis.DSH_TZ_ZONES）
 *
 * 用法：node tools/gen-zones.cjs
 * 幂等：每次运行先清空 inject/zones 目录，再重新生成，不会残留脏文件。
 */
'use strict';

const fs = require('node:fs');
const vm = require('vm');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(PROJECT_ROOT, 'extension');
const ZONES_DIR = path.join(EXTENSION_DIR, 'inject', 'zones');
const SHARED_DIR = path.join(EXTENSION_DIR, 'shared');
const CATALOG_FILE = path.join(SHARED_DIR, 'zones.js');

/** 低于这个数量说明 Intl 时区数据异常，改用兜底列表 */
const MIN_ZONE_COUNT = 100;

/** 推荐时区：置顶展示，label 使用中文 */
const RECOMMENDED = Object.freeze([
  { zone: 'America/Los_Angeles', label: '美国西部 · 洛杉矶' },
  { zone: 'America/New_York', label: '美国东部 · 纽约' },
  { zone: 'Europe/London', label: '英国 · 伦敦' },
  { zone: 'Asia/Tokyo', label: '日本 · 东京' },
  { zone: 'Asia/Singapore', label: '新加坡' },
  { zone: 'Australia/Sydney', label: '澳洲 · 悉尼' },
  { zone: 'Europe/Paris', label: '法国 · 巴黎' },
  { zone: 'Asia/Dubai', label: '阿联酋 · 迪拜' },
]);

/** Intl.supportedValuesOf 不可用时的兜底时区 */
const FALLBACK_ZONES = Object.freeze([
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Seoul',
  'Asia/Bangkok',
  'Asia/Kolkata',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'America/Chicago',
  'America/Denver',
  'America/Toronto',
  'America/Vancouver',
  'America/Sao_Paulo',
  'Pacific/Auckland',
]);

/** 判断是否为运行时（ICU）认可 IANA 时区 */
function isValidZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (err) {
    return false;
  }
}

/** IANA 时区 -> 文件名 slug（小写 + 非字母数字折叠成 _，去掉首尾 _） */
function slugify(zone) {
  const slug = String(zone)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'zone';
}

/** 读取全部时区并校验 */
function readZoneList() {
  let raw = [];
  try {
    if (typeof Intl.supportedValuesOf === 'function') raw = Intl.supportedValuesOf('timeZone');
  } catch (err) {
    console.warn('[gen-zones] Intl.supportedValuesOf 不可用：' + (err && err.message));
  }
  const zones = new Set();
  for (const zone of raw) if (isValidZone(zone)) zones.add(zone);
  zones.add('UTC');
  for (const item of RECOMMENDED) if (isValidZone(item.zone)) zones.add(item.zone);

  if (zones.size < MIN_ZONE_COUNT) {
    console.warn('[gen-zones] 时区数据偏少（' + zones.size + '），补充兜底列表');
    for (const zone of FALLBACK_ZONES) if (isValidZone(zone)) zones.add(zone);
  }
  for (const zone of [...zones]) if (!isValidZone(zone)) zones.delete(zone);
  return zones;
}

/**
 * 生成有序的条目列表：推荐时区按定义顺序置顶，其余按字母序。
 * 同时分配 slug，冲突时追加 -2/-3 后缀，保证文件名唯一。
 */
function buildEntries(zones) {
  const entries = [];
  const seen = new Set();
  for (const item of RECOMMENDED) {
    if (!zones.has(item.zone)) continue;
    entries.push({ zone: item.zone, label: item.label, recommended: true });
    seen.add(item.zone);
  }
  const rest = [...zones].filter((zone) => !seen.has(zone)).sort((a, b) => a.localeCompare(b, 'en'));
  for (const zone of rest) entries.push({ zone, label: zone, recommended: false });

  const used = new Map();
  const collisions = [];
  for (const entry of entries) {
    const base = slugify(entry.zone);
    let slug = base;
    let suffix = 1;
    while (used.has(slug)) {
      suffix += 1;
      slug = base + '-' + suffix;
    }
    if (slug !== base) collisions.push(base + ' -> ' + slug);
    used.set(slug, entry.zone);
    entry.slug = slug;
  }
  return { entries, collisions };
}

/** 清空并重建 inject/zones，写入每个时区单行文件 */
function writeZoneFiles(entries) {
  fs.rmSync(ZONES_DIR, { recursive: true, force: true });
  fs.mkdirSync(ZONES_DIR, { recursive: true });
  for (const entry of entries) {
    const file = path.join(ZONES_DIR, entry.slug + '.js');
    /*
     * 用 defineProperty 定义成不可枚举：直接赋值会让这个变量出现在
     * Object.keys(globalThis) 里，页面一行代码就能看出被注入了。
     * 不可枚举后只能通过已知的变量名读到，隐蔽性更高。
     */
    fs.writeFileSync(
      file,
      'Object.defineProperty(globalThis, "__DSH_TZ_FIX_ZONE__", ' +
        '{ value: ' + JSON.stringify(entry.zone) + ', writable: true, configurable: true, enumerable: false });\n',
      'utf8'
    );
  }
  return entries.length;
}

/** 写入 shared/zones.js 时区目录 */
function writeCatalog(entries) {
  const lines = [
    '/* 由 tools/gen-zones.cjs 自动生成，请勿手工编辑。',
    ' * 时区总数：' + entries.length + '；推荐：' + entries.filter((e) => e.recommended).length + '。',
    ' * 结构：[{ zone, label, slug, recommended }]',
    ' */',
    'globalThis.DSH_TZ_ZONES = [',
  ];
  for (const entry of entries) {
    lines.push(
      '  {"zone":' +
        JSON.stringify(entry.zone) +
        ',"label":' +
        JSON.stringify(entry.label) +
        ',"slug":' +
        JSON.stringify(entry.slug) +
        ',"recommended":' +
        (entry.recommended ? 'true' : 'false') +
        '},'
    );
  }
  lines.push('];', '');
  fs.mkdirSync(SHARED_DIR, { recursive: true });
  fs.writeFileSync(CATALOG_FILE, lines.join('\n'), 'utf8');
}

/** 简单自检：文件是否存在、内容是否符合预期、slug 是否唯一 */
function verify(entries) {
  const problems = [];
  const slugs = new Set();
  for (const entry of entries) {
    if (slugs.has(entry.slug)) problems.push('slug 重复：' + entry.slug);
    slugs.add(entry.slug);
    const file = path.join(ZONES_DIR, entry.slug + '.js');
    if (!fs.existsSync(file)) {
      problems.push('缺少文件：' + path.relative(PROJECT_ROOT, file));
      continue;
    }
    /*
     * 用「实际执行一遍、检查变量值」的方式校验，而不是比对字符串模板——
     * 后者每次调整生成格式都要跟着改，容易漏。
     */
    const content = fs.readFileSync(file, 'utf8');
    try {
      const sandbox = { globalThis: null };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(content, sandbox, { filename: entry.slug + '.js' });
      if (sandbox.__DSH_TZ_FIX_ZONE__ !== entry.zone) {
        problems.push('时区值不符：' + path.relative(PROJECT_ROOT, file));
      }
      // 必须不可枚举，否则页面 Object.keys(globalThis) 就能发现
      if (Object.keys(sandbox).indexOf('__DSH_TZ_FIX_ZONE__') >= 0) {
        problems.push('变量可枚举：' + path.relative(PROJECT_ROOT, file));
      }
    } catch (err) {
      problems.push('执行失败：' + path.relative(PROJECT_ROOT, file) + ' — ' + (err && err.message));
    }
  }
  if (!fs.existsSync(CATALOG_FILE)) problems.push('缺少目录文件：' + path.relative(PROJECT_ROOT, CATALOG_FILE));
  return problems;
}

function main() {
  const startedAt = Date.now();
  const zones = readZoneList();
  const { entries, collisions } = buildEntries(zones);
  if (!entries.some((entry) => entry.zone === 'America/Los_Angeles')) {
    throw new Error('缺少默认时区 America/Los_Angeles');
  }
  const fileCount = writeZoneFiles(entries);
  writeCatalog(entries);
  const problems = verify(entries);

  const recommendedCount = entries.filter((entry) => entry.recommended).length;
  console.log('[gen-zones] 时区总数：' + entries.length + '（推荐 ' + recommendedCount + '，其他 ' + (entries.length - recommendedCount) + '）');
  console.log('[gen-zones] 注入文件：' + fileCount + ' 个 -> ' + path.relative(PROJECT_ROOT, ZONES_DIR));
  console.log('[gen-zones] 时区目录：' + path.relative(PROJECT_ROOT, CATALOG_FILE));
  if (collisions.length) console.log('[gen-zones] slug 冲突已自动去重：' + collisions.join(', '));
  console.log('[gen-zones] 耗时：' + (Date.now() - startedAt) + ' ms');
  if (problems.length) {
    console.error('[gen-zones] 自检失败：');
    for (const problem of problems.slice(0, 20)) console.error('  - ' + problem);
    process.exitCode = 1;
    return;
  }
  console.log('[gen-zones] 自检通过 ✓');
}

main();
