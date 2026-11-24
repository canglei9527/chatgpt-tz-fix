/*
 * shared/geo-zones.js —— 出口 IP 国家/地区 → 推荐 IANA 时区
 *
 * 被 popup.js 和 background.js 共用（两边都用 importScripts / <script> 引入）。
 *
 * 为什么要做这个映射：
 *   社区反馈一致认为「时区必须和出口 IP 一致」，而不是「一律选美国」。
 *   IP 在日本却选洛杉矶，等于主动制造矛盾信号，反而更容易被判定异常。
 *   所以扩展会查询出口 IP 归属地，自动把时区切到匹配的城市。
 *
 * 维护注意：
 *   这里每个值都必须真实存在于 shared/zones.js 的目录中，
 *   否则用户点「跟随代理」会设置一个不存在的时区。
 *   tests/ip-zone-map.test.cjs 会自动校验这一点。
 *
 *   时区名要使用 ICU 规范名：
 *     · 乌克兰用 Europe/Kiev（不是 Kyiv）
 *     · 越南用 Asia/Saigon（不是 Ho_Chi_Minh）
 *     · 阿根廷用 America/Argentina/Salta 等，没有 Buenos_Aires 这个 ICU 名
 */
(function (root) {
  'use strict';

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

  // 浏览器扩展里挂到 globalThis；Node 测试里走 module.exports
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { COUNTRY_ZONE: COUNTRY_ZONE };
  }
  if (root) {
    root.DSH_COUNTRY_ZONE = COUNTRY_ZONE;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
