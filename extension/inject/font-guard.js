/*
 * ⚠ 本文件由 tools/build.cjs 从 src/font-guard.js 自动生成，请勿直接修改。
 * 修改请编辑 src/font-guard.js 后重新运行：node tools/build.cjs
 */
/*
 * font-guard.js —— 中文字体指纹模糊
 *
 * 问题
 *   检测站点会枚举系统字体来判断你在哪个地区：
 *     · document.fonts.check('12px SimHei')   → 装了黑体就是中国环境
 *     · Canvas measureText 比对回退字体宽度   → 同上
 *   即使时区/IP/语言都伪装好了，字体这一项照样暴露。
 *
 * 我们做什么
 *   只改「探测结果」，不改「实际渲染」：
 *     1. document.fonts.check()：查询中国大陆常见字体时返回 false
 *     2. CanvasRenderingContext2D.prototype.measureText：把 font 字符串里
 *        的中国字体名剔除后再测（这样宽度与"没装该字体"一致）
 *     3. OffscreenCanvasRenderingContext2D 同样处理
 *
 * 为什么不影响正常使用
 *   真实页面渲染时用的是 CSS font-family 回退链，走的是浏览器内部排版，
 *   不经过 measureText；改的只是 JS 主动探测量宽这个动作。
 *   页面自己用 measureText 做布局计算时，去掉一个本来就不该被显式指定的
 *   字体名，宽度差异仅出现在该字体真的被命中时——而我们要隐藏的正是这个。
 */
(function () {
  'use strict';

  var MARK = '__DSH_FONT_GUARD__';
  if (globalThis[MARK]) return;

  /*
   * 需要"假装不存在"的字体。
   * 覆盖 Windows 简体中文默认字体 + 常见检测目标。
   * 名称要同时包含英文名和中文名，因为 check() 两种都可能传。
   */
  var CN_FONTS = [
    'SimSun', '宋体', 'NSimSun', '新宋体',
    'SimHei', '黑体',
    'KaiTi', '楷体', 'KaiTi_GB2312',
    'FangSong', '仿宋', 'FangSong_GB2312',
    'Microsoft YaHei', '微软雅黑', 'Microsoft YaHei UI', '微软雅黑 UI',
    'Microsoft JhengHei', '微軟正黑體',
    'DengXian', '等线', 'DengXian Light',
    'STSong', '华文宋体', 'STKaiti', '华文楷体',
    'STFangsong', '华文仿宋', 'STHeiti', '华文黑体',
    'FZShuTi', '方正舒体', 'FZYaoti', '方正姚体',
    'YouYuan', '幼圆', 'LiSu', '隶书',
    'MS Gothic', 'MS PGothic',       // 日文，顺带一起
    'Meiryo', 'Yu Gothic', 'YuGothic',
    'Malgun Gothic', 'Gulim', 'Dotum', // 韩文
    'Vrinda', 'Nirmala UI'             // 南亚
  ];

  /* 转小写做快速匹配 */
  var CN_FONT_SET = Object.create(null);
  CN_FONTS.forEach(function (name) {
    CN_FONT_SET[name.toLowerCase()] = name;
  });

  /** 从「字体名列表」里剔除中国字体，返回剩余部分 */
  function stripCnFonts(fontList) {
    if (typeof fontList !== 'string' || !fontList) return fontList;
    /*
     * CSS font 简写里字体名可能是：
     *   "Microsoft YaHei", sans-serif
     *   'SimHei'
     *   楷体
     * 分隔符是逗号，名字里可能带引号或空格。
     */
    var parts = fontList.split(',');
    var kept = [];
    for (var i = 0; i < parts.length; i += 1) {
      var raw = parts[i];
      var bare = raw.trim().replace(/^["']|["']$/g, '').trim();
      if (!bare) continue;
      if (CN_FONT_SET[bare.toLowerCase()]) continue;   // 剔除
      kept.push(raw);
    }
    // 全被剔光了就退回一个通用族，避免字体变成空串
    if (!kept.length) return 'sans-serif';
    return kept.join(',');
  }

  /** 判断一个 font 说明（如 "12px SimHei"）是否只是想探测中国字体 */
  function fontSpecMentionsCn(fontSpec) {
    if (typeof fontSpec !== 'string') return false;
    var lower = fontSpec.toLowerCase();
    for (var key in CN_FONT_SET) {
      if (lower.indexOf(key) >= 0) return true;
    }
    return false;
  }

  /** 从 font 简写里剥离中国字体，保留字号/字重等前缀 */
  function stripCnFromFontSpec(fontSpec) {
    if (typeof fontSpec !== 'string') return fontSpec;
    // 前缀形如 "italic bold 12px/1.2 "，字体族在最后
    var m = /^(.*?)(\d+(?:\.\d+)?px(?:\s*\/\s*[0-9.]+\S*)?\s+)(.+)$/.exec(fontSpec);
    var prefix = '';
    var families = fontSpec;
    if (m) {
      prefix = m[1] + m[2];
      families = m[3];
    }
    var stripped = stripCnFonts(families);
    return prefix + stripped;
  }

  /* --------------------------------------------------- 1) document.fonts */

  function installFontFaceSet() {
    var fonts = typeof document !== 'undefined' ? document.fonts : null;
    if (!fonts || typeof fonts.check !== 'function') return false;

    var realCheck = fonts.check.bind(fonts);
    var patched = function check(font, text) {
      try {
        if (fontSpecMentionsCn(font)) return false;   // 假装没装
      } catch (err) { /* 忽略 */ }
      return realCheck(font, text);
    };

    try {
      Object.defineProperty(fonts, 'check', {
        value: patched,
        writable: true,
        configurable: true,
        enumerable: false
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---------------------------------------------- 2) Canvas measureText */

  function patchCanvasProto(proto, label) {
    if (!proto || typeof proto.measureText !== 'function') return false;
    var realMeasure = proto.measureText;

    var patched = function measureText(text) {
      try {
        var current = this.font;
        if (typeof current === 'string' && fontSpecMentionsCn(current)) {
          var next = stripCnFromFontSpec(current);
          if (next !== current) {
            // 临时换字体测量，测完还原，避免被页面察觉 font 被改过
            this.font = next;
            var result = realMeasure.call(this, text);
            this.font = current;
            return result;
          }
        }
      } catch (err) { /* 异常就走原始路径 */ }
      return realMeasure.call(this, text);
    };

    try {
      Object.defineProperty(proto, 'measureText', {
        value: patched,
        writable: true,
        configurable: true,
        enumerable: false
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  var okSet = installFontFaceSet();
  var okCanvas = false;
  try {
    if (typeof CanvasRenderingContext2D === 'function') {
      okCanvas = patchCanvasProto(CanvasRenderingContext2D.prototype, '2d') || okCanvas;
    }
  } catch (err) { /* 忽略 */ }
  try {
    if (typeof OffscreenCanvasRenderingContext2D === 'function') {
      okCanvas = patchCanvasProto(OffscreenCanvasRenderingContext2D.prototype, 'offscreen') || okCanvas;
    }
  } catch (err) { /* 忽略 */ }

  try {
    Object.defineProperty(globalThis, MARK, {
      value: Object.freeze({
        installed: okSet || okCanvas,
        fontFaceSet: okSet,
        canvas: okCanvas,
        count: CN_FONTS.length
      }),
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (err) { /* 忽略 */ }
})();
