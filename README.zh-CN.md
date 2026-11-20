# ChatGPT 时区修复

[English](README.md) · **简体中文**

> 一行代码解决 ChatGPT 网页端「降智」——用浏览器扩展自动把页面 JS 时区伪装成海外时区，等价于 DevTools 的 Sensors → Timezone 覆盖，但**不用每次开 F12**。

---

## 一、这个扩展解决什么

ChatGPT 网页端会读取浏览器的本地时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）。当它看到 `Asia/Shanghai` 这类时区时，部分用户反馈模型回答质量明显下降（俗称「降智」）。

截图里流传的做法是：**F12 → 控制台 → 打开控制台抽屉 → 传感器 → 把时区改成美国某城市**。

问题在于：

| 手动改传感器 | 本扩展 |
| --- | --- |
| 每次开浏览器都要重做一遍 | 安装一次，永久生效 |
| 必须开着 DevTools，占用屏幕 | 后台静默生效 |
| 关掉 DevTools 就失效 | 关掉标签页也保持 |
| 手机上没法用 | 同一账号在桌面端稳定生效 |

**原理完全一样**：页面里所有 JS 看到的「本地时间」都变成目标时区的本地时间，而你的系统时区、系统时间不受任何影响。网络请求本身不携带时区信息，所以服务端看到的就是「这个用户在美国」。

---

## 二、30 秒安装（Windows / macOS / Linux 通用）

### 1. 构建发布目录（只需一次）

```bash
node tools/build.cjs
```

产物在 `dist/chatgpt-tz-fix/`，这就是可以加载的扩展目录。

> Windows 用户也可以直接双击 `install.cmd`：它会检查构建产物、打开 `chrome://extensions`、并在资源管理器里定位到扩展目录。

### 2. 在 Chrome / Edge 中加载

1. 地址栏输入 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 打开右上角「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」
4. 选择 `dist/chatgpt-tz-fix` 目录

加载完成后扩展会自动打开 ChatGPT 页面。

### 3. 验证

- 点击工具栏上的扩展图标，弹窗里会显示「真实时区 / 伪装时区」和双时钟对照；
- 点「**立即检测当前标签页**」，如果显示「这个页面已经生效 ✓」就成功了；
- 想更彻底地验证，点弹窗里的「**自检**」，会打开一个完整的自检页，逐项比对注入引擎和你当前浏览器原生行为是否完全一致。

---

## 三、怎么用

打开扩展弹窗：

| 控件 | 说明 |
| --- | --- |
| 顶部开关 | 一键开启 / 关闭伪装，立即生效 |
| 时区选择 | 默认 **美国西部 · 洛杉矶**（`America/Los_Angeles`）。推荐列表置顶，也可搜索任意 IANA 时区（共 419 个） |
| 生效范围 | 「仅 ChatGPT 站点」= 只影响 chatgpt.com / chat.openai.com；「所有网站」= 全站伪装 |
| 立即检测当前标签页 | 在当前页面执行一次探针，确认伪装真的生效 |
| 刷新页面 | 重新加载当前标签页 |
| 自检 | 打开自检页，做完整的 300+ 项行为比对 |

> **改完设置请在 ChatGPT 页面按 F5 刷新**（内容脚本只在页面加载时注入）。

### 选哪个时区

| 场景 | 建议 |
| --- | --- |
| 日常使用 | 美国西部 · 洛杉矶（与主流默认预期一致） |
| 想更「自然」 | 美国东部 · 纽约 |
| 有明确地区偏好 | 英国 · 伦敦 / 日本 · 东京 / 新加坡 |

不要选 `Asia/Shanghai`——那等于没伪装。

---

## 四、原理（它是怎么做到「和真身完全一致」的）

### 4.1 注入方式

Chrome MV3 的 `chrome.scripting.registerContentScripts` 支持 `world: "MAIN"`，可以把脚本注入到**页面主世界**（和页面自己的 JS 同一个上下文），并且在 `document_start` 时执行——比页面任何脚本都早。

注入两个文件（顺序固定）：

1. `inject/zones/<slug>.js` —— 一行：`globalThis.__DSH_TZ_FIX_ZONE__ = "America/Los_Angeles";`
2. `inject/tz-shim.js` —— 真正的伪装脚本

### 4.2 伪装哪些 API

| 分类 | 覆盖内容 |
| --- | --- |
| 读取 | `getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds/getYear/getTimezoneOffset` |
| 输出 | `toString/toDateString/toTimeString/toLocaleString/toLocaleDateString/toLocaleTimeString` |
| 写入 | `setFullYear/setMonth/setDate/setHours/setMinutes/setSeconds/setMilliseconds/setYear` |
| 构造 | `new Date()`、`new Date(ms)`、`new Date(str)`、`new Date(y,m,d,...)`、`Date()`、`Date.parse`、`class X extends Date` |
| Intl | `Intl.DateTimeFormat` 默认时区（显式传 `timeZone` 的调用不覆盖） |
| Temporal | 存在时同步（目前主流浏览器尚未默认开启） |

**不覆盖**：所有 UTC 系列方法、`Date.now`、`Date.UTC`、`toISOString`、时间戳本身。也就是说「绝对时间」完全不变，只有「本地时间怎么显示、怎么解释」变了。

### 4.3 关键算法：为什么 DST 也和真身一致

```
wall(ts)        = 用 Intl.DateTimeFormat 在目标时区渲染 ts，得到墙上时间字段
offset(ts)      = Date.UTC(wall 的字段) - ts
getTimezoneOffset() = -offset(ts) / 60000
localToUtc(t)   = t - offset(t)      ← 按 ES 规范口径，只查一次表
```

这个「只查一次表」的做法很关键：夏令时切换时有**不存在的时间**（春季跳变）和**重复的时间**（秋季重叠），不同算法给出的取舍不同。用 `localToUtc(t) = t - offset(t)` 恰好和 V8 内部实现一致，所以：

```js
// America/Los_Angeles 下（春季跳变，2:30 不存在）
new Date(2026, 2, 8, 2, 30).toISOString() === '2026-03-08T10:30:00.000Z'   // ✓ 与真身一致

// 秋季重叠，1:30 出现两次
new Date(2026, 10, 1, 1, 30).toISOString() === '2026-11-01T08:30:00.000Z' // ✓ 与真身一致
```

### 4.4 性能

`wall()` 的结果带 LRU 风格的缓存（上限 8192 条），`Intl.DateTimeFormat` 实例也按 key 缓存。实测 10 万次 `getHours()` 在 200ms 以内，对页面无感。

---

## 五、验证体系（这是本项目的重点）

伪装脚本最难的不是「大致对」，而是「每个角落都和真身一样」。项目内建三层验证：

### 5.1 自检页（`extension/verify/`）

弹窗点「自检」打开。它在**隐藏 iframe** 里真实加载 `inject/tz-shim.js`，然后逐项比对：

- **参考值**由未伪装的宿主页面用原生 `Intl`（显式 `timeZone`）独立重建；
- **观测值**由被伪装的 iframe 采集；
- 两边算法完全独立，任何一边写错都会暴露成差异。

覆盖 300+ 项断言，分组显示：本地时间字段 / 字符串表示 / 本地化格式 / 构造语义 / 设置器 / 字符串解析 / Intl / 原生语义保持 / DST 偏移集合 / 性能 / 注入标记。

### 5.2 自动化测试

```bash
node tests/run-all.cjs
```

| 测试 | 内容 |
| --- | --- |
| `tests/verify-page.test.cjs` | 自检页参考算法 vs 浏览器原生（10 个时区，含半时区 +5:30 / +12:45 / -3:30），外加「错配时区必须被识别」的反向验证 |
| `tests/ui-mock.test.cjs` | 扩展外壳：假 chrome API 下断言注册参数、状态校验、消息分支、manifest 完整性、popup DOM id 一致性、全部 JS 语法 |
| `tests/shim-selfcheck.cjs` | 伪装脚本 vs 真身（子进程 `TZ=<zone>`）的差分对拍，对抗式回归 |

### 5.3 真身对拍的含义

`native` 组用子进程设置 `TZ=America/Los_Angeles` 跑同一套探针——那就是「操作系统时区真的是洛杉矶」的 Node。`shim` 组在自己进程里加载伪装脚本。两组 JSON 逐字段比对，必须 0 差异。

当前结果（3846 个探针 / 每组时区，含 DST 逐小时扫描、极值、Invalid、子类、Intl）：

```
16 组时区 × 3846 探针：硬差异 0
  America/Los_Angeles（宿主 Asia/Shanghai）、America/Los_Angeles（宿主 UTC）
  America/New_York、America/St_Johns(-3:30)、Europe/London、Europe/Berlin
  Europe/Dublin、Asia/Tokyo、Asia/Shanghai（宿主反向）、Asia/Calcutta(+5:30)
  Asia/Kolkata、Pacific/Chatham(+12:45)、Australia/Sydney
  Australia/Lord_Howe(30 分钟 DST)、UTC、Pacific/Kiritimati(+14)

419 个时区全量冒烟：419/419 通过
差分引擎自证（--selftest 空操作替身）：16 组 0 差异，无假阳性
tests/run-all.cjs：外壳 62 项 + 自检页 23 项 + 差分 21 用例，全部通过

性能：100k 次 getHours = 85ms（真身 14ms，门限 200ms）
```

> 注：1971 年以前的历史时刻，`toString()` 括号里的时区**显示名**可能与原生有出入
> （V8 的 DateCache 与 ICU 是两套命名数据源）。这只影响文案，不影响任何数值行为，
> 且 ChatGPT 页面不会用到 1970 年之前的时间点。

---

## 六、目录结构

```
chatgpt-tz-fix/
├── src/
│   └── tz-shim.js              ← 伪装核心（唯一需要理解的文件）
├── extension/                  ← 扩展源码
│   ├── manifest.json
│   ├── background.js           ← MV3 service worker：注册/注销内容脚本、消息、徽标
│   ├── popup/                  ← 弹窗界面（html/css/js）
│   ├── inject/
│   │   ├── tz-shim.js          ← 构建产物（由 src/ 拷贝而来，勿手改）
│   │   └── zones/*.js          ← 419 个时区变量文件
│   ├── shared/zones.js         ← 时区目录（I标的 + 中文标签 + slug）
│   ├── icons/                  ← 16/32/48/128 图标
│   └── verify/                 ← 自检页
├── tools/
│   ├── build.cjs               ← 构建 + 结构校验 + 组装 dist
│   ├── gen-zones.cjs           ← 生成时区目录与 zone 文件
│   └── gen-icons.py            ← 生成图标（Pillow）
├── tests/
│   ├── run-all.cjs             ← 一键跑全部测试
│   ├── realm-probe.cjs         ← 「页面环境」子进程采集器
│   ├── verify-page.test.cjs
│   ├── ui-mock.test.cjs
│   └── shim-selfcheck.cjs
├── install.cmd / install.ps1   ← Windows 一键安装助手
└── dist/chatgpt-tz-fix/        ← 加载已解压的扩展程序时选这个目录
```

---

## 六点五、关于「降智」的重要说明

这个扩展忠实复刻了 DevTools → Sensors → Timezone 的效果。但「改时区能否改变服务端路由到哪个模型」**是社区假设，不是 OpenAI 官方文档化的行为**。

2025 年底至 2026 年的多个社区报告比较一致的说法是：**关键是让时区和出口 IP 匹配**，而不是「一律选美国时区」：

| 你的出口 IP | 该选的时区 |
| :--- | :--- |
| 美国西部 / 洛杉矶节点 | `America/Los_Angeles`（默认） |
| 美国东部 / 纽约节点 | `America/New_York` |
| 日本节点 | `Asia/Tokyo` |
| 新加坡节点 | `Asia/Singapore` |
| 英国 / 欧洲节点 | `Europe/London` |

**IP 不在美国却选了美国时区，等于制造了新的不一致**，可能反而更糟。先打开 `https://ipinfo.io` 看出口国家，再选对应时区。

另外几点：

- **时区只是若干因素之一**。会话长度、限流、账号风控在实际中影响更大。遇到「变笨」**先开新会话试试**——过长的上下文是「变笨」最常见的原因。
- **怎么确认生效**：别用概率性的模型指纹工具。用弹窗里的「**立即检测当前标签页**」——它直接读 `Intl.DateTimeFormat().resolvedOptions().timeZone`，是确定性的事实判断。
- **改完时区后**，清掉 ChatGPT 的 cookie 再重新登录。降级标记据说有时效，需要让账号重新被评估。

---

## 六点六、WebRTC 本机 IP 防泄露（可选）

如果你的目的是「让网站以为我在美国」，时区只是其中一个信号。**WebRTC 会泄露你的真实 IP**，比时区更容易被识破。

### 问题是什么

WebRTC 建立连接前会收集「候选地址」，其中两类携带你的真实位置：

| 候选类型 | 含义 | 风险 |
| :--- | :--- | :--- |
| `typ host` | 本机网卡地址（192.168.x.x / 10.x.x.x） | 暴露内网结构 |
| `typ srflx` | NAT 映射后的**公网 IP** | **绕过代理暴露真实 IP** |
| `typ relay` | TURN 中继服务器地址 | 安全，与代理出口一致 |

网页只要列一遍 `candidates` 就能拿到 `typ srflx` 里的真实 IP —— 即使你挂着美国节点，它看到的仍是中国 IP。

### 本扩展怎么处理

弹窗里新增「**屏蔽 WebRTC 本机 IP**」开关（默认关闭）。打开后：

- 过滤 `onicecandidate` 和 `addEventListener('icecandidate')` 两条路径，丢弃 `host` / `srflx`
- 清洗 `localDescription` / `currentLocalDescription` / `pendingLocalDescription` 的 SDP，剔除对应 `a=candidate` 行
- **保留 `typ relay`**，不影响正常连通性

### 为什么不强制走中继

强制中继（`iceTransportPolicy: 'relay'`）需要可用的 TURN 服务器，没有的话 WebRTC 直接不可用（视频通话会挂）。本扩展用的是**过滤模式**：连接在浏览器内部照常建立，只是页面 JS 拿不到能定位你的候选。

### 什么时候该打开

- ✅ 你挂着代理，且希望网站看到的位置和出口 IP 一致
- ✅ 你在意真实 IP 不被网页拿到
- ⚠️ 关闭它：某些网站的音视频功能异常时，可先关掉这个开关排查

---

## 七、常见问题

**Q：安装后没效果？**
按顺序排查：① 弹窗开关是否是开着的；② 生效范围是否包含当前站点；③ 在 ChatGPT 页面按 F5 刷新（内容脚本只在页面加载时注入）；④ 点弹窗「立即检测当前标签页」看页面时区是否已经是目标时区。

**Q：会影响别的网站吗？**
默认「仅 ChatGPT 站点」，只匹配 `chatgpt.com` / `chat.openai.com` 及其子域。切到「所有网站」才会全站生效（比如某些 API 需要海外时区的场景）。

**Q：会不会拖慢网页？**
不会。时区偏移按「年」建转场表缓存（每年只查几十次 Intl，之后全是二分查找）；实测 10 万次 `getHours` 约 85ms，即每次不到 1 微秒。原生本身也要 14ms，量级相同。

**Q：需要什么版本的浏览器？**
Chrome / Edge **111 或更高**（需要 `chrome.scripting.registerContentScripts` 的 `world: "MAIN"` 参数）。Firefox 暂不支持（`world` 语义不同）。

**Q：会不会被检测出来？**
数值行为上完全无法区分：`Date.prototype` 是同一对象（没被替换）、`instanceof` 正常、`Object.prototype.toString` 仍是 `[object Date]`、`JSON.stringify` 正常、所有 UTC 方法与时间戳原样。

理论上的唯一痕迹是 `Function.prototype.toString.call(Date)` 会返回 `"function TzDate(...)"` 而不是 `"function Date() { [native code] }"`。但没有正常业务代码会这么干——ChatGPT 网页端也不会。

**Q：手机上能用吗？**
桌面版 Chrome / Edge 可以。Android 版 Chrome 不支持扩展；iOS 需用 Safari 扩展方案，不在本项目范围。

**Q：想临时关掉？**
点弹窗顶部开关即可，刷新页面后恢复真实时区。

**Q：不改系统时区吗？**
不改。你的系统时间、任务栏时间、其它软件都保持原样。

**Q：不用扩展，只想手动改一次？**
按截图来：F12 → 控制台 → 右上角 ⋮ → 「显示控制台抽屉栏」→ 抽屉里选「传感器」→ 位置改成自定义 → 时区选 `America/Los_Angeles` → 刷新页面。缺点是关掉 DevTools 就失效。

---

## 八、权限说明（为什么需要这些）

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存你的设置（开关、时区、生效范围） |
| `scripting` | 动态注册 / 注销 MAIN world 内容脚本 |
| `host_permissions: <all_urls>` | 让「所有网站」模式可用；默认模式下实际注入只发生在 ChatGPT 域名 |

扩展**不收集任何数据**：没有网络请求、没有远程配置、没有埋点统计。所有逻辑都在本地。

---

## 九、卸载

`chrome://extensions` → 找到「时区修复 · ChatGPT」→ 移除。刷新页面即恢复真实时区，无残留。

---

## 十、开发

```bash
node tools/gen-zones.cjs        # 重新生成时区目录（419 个）
python tools/gen-icons.py       # 重新生成图标
node tools/build.cjs            # 构建 + 校验 + 组装 dist
node tests/run-all.cjs          # 跑全部测试
node tools/build.cjs --no-dist  # 只校验，不产出 dist
```

修改伪装逻辑只需改 `src/tz-shim.js`，然后 `node tools/build.cjs` 会自动同步到 `extension/inject/tz-shim.js`。

**改完必须跑 `node tests/run-all.cjs`**，尤其是 `shim-selfcheck`——它是「伪装 vs 真身」的差分对拍，任何语义偏差都会被抓出来。
