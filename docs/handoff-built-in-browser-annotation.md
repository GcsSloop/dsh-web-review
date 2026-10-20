# 交接：把批注接到官方客户端的内置浏览器

> 状态存档于 2026-10-20（第 2 轮）。新会话读这一份即可继续，无需翻历史。

## 目标

`dsh-web-review` 原本自带「网页预览」Tab（插件自己的预览传输 + 拾取器 + 编辑器）。
用户已切到**官方 Electron 客户端**，希望：

1. **删掉插件自己的「网页预览」Tab**（已完成，`e2c1729`）；
2. **把元素拾取 / 批注直接挂在客户端内置的「浏览器」Tab 上**（本轮已实现，待真机验收）。

## 环境事实（都已实测确认）

| 项 | 值 |
|---|---|
| 客户端 | 官方 Electron 版 **0.2.1-rc.2**（Electron 44.7.0 / Chromium 152 / node 24.21.0），`/Applications/DeepSeek Harness.app` |
| 运行 profile | `~/.dsh/profiles/desktop`（进程参数可验证） |
| profile 管理 | **CLI 拒绝管理 `desktop`**：`error: profile "desktop" is managed exclusively by the Electron application` |
| 内置 node | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`（v24.21.0） |
| 内置 pnpm | 同目录 `.../dependencies/pnpm/bin/pnpm.mjs`（v11.28.5） |
| CLI 入口 | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` |
| 读取 asar 内文件 | `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e '<script>'`（Electron 的 fs 支持 asar 路径） |
| 插件包位置 | `app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-browser` |
| 内置浏览器 kind | `"browser"`（`BROWSER_KIND`），id `@deepseek-ai/dsh-client-ui-sidebar-browser` |
| 段内快捷键 | `data-sidebar-browser-frame="webview"` 是 guest 的唯一稳定标记 |

### 内置浏览器的实现（关键，已核对 0.2.1-rc.2 源码）

Electron 侧创建参数（`ElectronWebviewPresentation.createElement`）：

```js
element.dataset.sidebarBrowserFrame = "webview";
element.setAttribute("name", reservation.lease);
element.setAttribute("partition", reservation.partition);
element.setAttribute("allowpopups", "");
element.setAttribute("src", "about:blank#" + reservation.lease);
```

主进程 `DesktopBrowserGuests.bind()` 对所有 webview 强制：

```js
nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
webviewTag: false, plugins: false, devTools: !app.isPackaged
```

- **没有 preload** → 不能用 `ipcRenderer.sendToHost` / `ipc-message`。
- 页面是**真实 Origin**（与插件自己的隔离代理不同），cookie/存储随 workspace partition 走。
- 主进程只允许 http(s) 主框架导航；`will-frame-navigate` 会拒绝其它协议。

### 通道结论（本轮实测 + 设计）

宿主机 → 页面：`webview.executeJavaScript(...)`（唯一可用方向）。
页面 → 宿主：**队列 + 轮询**，不用 `console-message`：

- `executeJavaScript` 会把结果序列化回宿主，所以注入一个 `window.__DSH_WEB_REVIEW_WEBVIEW_SINK__`
  队列和 `window.__dshWebReviewDrain()`，宿主每 120ms 抽干一次；
- 选队列而不是 `console-message` 的原因：页面脚本可以替换 `console`（很多站点确实替换），
  而 `console-message` 的事件形状在 Electron 各版本间变过；轮询只依赖
  `executeJavaScript` 这一个稳定 API，且能同时带回当前 `location.href` / `title` / channel，
  一次往返完成“抽队列 + 判断文档是否已换”。

## 本轮已实现

提交前状态：`release/v1.0.0` 分支，上一轮 `e2c1729` / `043a23d`。

| 层 | 文件 | 内容 |
|---|---|---|
| node | [`src/index.ts`](../packages/dsh-web-review/src/index.ts) | 新路由 `GET /webview-bridge-source`：把构建好的 `lib/bridge.js` 交给浏览器半边注入（要求插件客户端头，避免被任意页面当静态资源拉取） |
| node | [`src/preview-contract.ts`](../packages/dsh-web-review/src/preview-contract.ts) | `PREVIEW_BRIDGE_SOURCE_PATH` 常量 |
| bridge | [`src/bridge/index.ts`](../packages/dsh-web-review/src/bridge/index.ts) | `deliver()` 优先走 host 注入的 sink；有 sink 时不注册 `window.postMessage` 监听（guest 没有可寻址的 parent） |
| client | [`src/client/webview-guest.ts`](../packages/dsh-web-review/src/client/webview-guest.ts) | guest 结构化类型、可见性判定、probe/drain 源码与解析、bootstrap（有界队列）、注入、`webviewCarrier` |
| client | [`src/client/browser-annotation.ts`](../packages/dsh-web-review/src/client/browser-annotation.ts) | `BrowserAnnotationSession`：扫描可见 guest → attach（探测/注入/合成 descriptor）→ `PreviewBridgeClient` → 文档更换后自动重建（新 channel + 重新 arm） |
| client | [`src/client/AnnotationDock.tsx`](../packages/dsh-web-review/src/client/AnnotationDock.tsx) + `.module.css` | 记录条根组件：`批注页面` / `继续批注` / `退出批注` 入口、URL、清空、发送按钮、`AnnotationEditor` 作为 composer 上方的 sheet |
| client | [`src/client/DraftOverlayBar.tsx`](../packages/dsh-web-review/src/client/DraftOverlayBar.tsx) | 新增 `inline` 模式（胶囊与入口共用一行）；注入面新增 `sendAnnotationsWithoutDraft` |
| client | [`src/client/index.ts`](../packages/dsh-web-review/src/client/index.ts) | dock 改注册 `AnnotationDock`；恢复 `scopedConversation` 以支持“无草稿发送” |
| client | [`src/client/locales.ts`](../packages/dsh-web-review/src/client/locales.ts) | 新增 `dock.annotate*` / `dock.page.missing` / `dock.bridge.*` 文案（中英） |

测试（全部通过）：

- `tests/webview-guest.spec.ts`：bootstrap 有界队列、drain 解析与裁剪、carrier 投递/陈旧文档、可见性判定。
- `tests/browser-annotation.spec.ts`：attach 注入配置、arm/disarm、marker 同步、文档替换后重建、无页面时报错。
- `tests/bridge-webview-sink.spec.ts`：bridge 优先走 sink、不再向 parent 投递、`__dshWebReviewReceive` 命令可用。
- `tests/browser-dock.spec.tsx`：入口只在有页面时出现、点选打开编辑器、确认后进入 picks、无草稿发送。

`pnpm test`（全量）除 4 个 **CDP 浏览器预览**用例外全绿；这 4 个在 HEAD 上同样失败
（本机 Playwright 本身能启动 Chromium，失败原因与本次改动无关，见“待完成”）。

## 运行时链路（本轮设计）

1. dock 挂载即开始 600ms 扫描 `webview[data-sidebar-browser-frame="webview"]`，
   用矩形与视口相交判断“可见”（隐藏的 Browser 标签仍在 DOM 里）。
2. 用户点 `批注页面` → `activate()`：
   - `executeJavaScript` 探测 `{href,title,channel}`；
   - 没有 sink 就注入 bootstrap + `__DSH_WEB_REVIEW_BRIDGE_CONFIG__` + `bridge.js`（去掉 sourceMappingURL）；
   - 用该文档的 origin 合成 descriptor（mode `browser`，sessionId/channel 本地随机），
     构建 `PreviewBridgeClient`，`frameLoaded()` 探测 ready。
3. carrier 每 120ms 抽一次队列：把 payload 交给 `PreviewBridgeClient`，
   顺带回写 url/title；发现 channel 变了（文档被替换）→ `onHandoff` → 重建。
4. 页面侧的拾取、标记圆点、样式/文本预览、回滚全部沿用既有 bridge，宿主侧完全复用既有协议。
5. 批注快照仍走 `/webview-annotations` → `agent/pre-step`，与上一轮一致。

## 已验证：Electron 真机机制冒烟（2026-10-20）

在真实的 **Electron 44.7.0（与官方客户端同版本）** 里用与 DSH 主进程完全相同的
webview 策略（`sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`）
跑通了一次完整链路，用的就是构建产物 `lib/bridge.js`：

```
dom-ready
loaded  http://127.0.0.1:63037/app/  title=Smoke
probe   { href, title, ready: true }          ← executeJavaScript 回传结构体
drain   []                                     ← 注入队列后抽干
drain-large { length: 20000 }                  ← 20KB payload 无损
bridge-injected                                ← 注入真实 bridge + config
bridge-ready ["ready"]                         ← channel / pageUrl / viewport 正确
picker-armed true                              ← host 命令 → dsh-wv-picking
pick    { cssPath: "#go", tagName: "button", label: "Go", handle: true }
responses ["1-smoke"]                          ← 命令响应走同一队列
```

结论：`executeJavaScript` 双向、队列轮询、bridge 注入、拾取事件、命令响应的机制全部成立。
冒烟工装不在仓库里（gitignored `.artifacts/electron-smoke`），复现方式：

```sh
cd .artifacts/electron-smoke      # package.json + main.js + index.html，Electron 44.7.0
cp ../dsh-web-review/packages/dsh-web-review/lib/bridge.js .
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . \
  --no-sandbox --disable-gpu --user-data-dir="$PWD/udd"
```

（`ELECTRON_RUN_AS_NODE` 是 DSH 运行时注入的；不加 `--no-sandbox --disable-gpu` 时
Chromium 在受限沙箱里起不来——这也是 `pnpm check` 里 4 个 CDP 用例在本机失败的原因。）

## 待完成（按此顺序）

### 1. 真机验收（剩下唯一没做的验证）

机制已冒烟，但**插件在真实客户端里的装载与 UI 还没有跑过一次**。
需要：把当前 checkout 装进 `~/.dsh/profiles/desktop`，完全退出并重开客户端，然后：

- 打开右侧「浏览器」Tab 加载一个 http(s) 页面（可用 `pnpm demo` 的 5173，或任意站点）；
- 确认 composer 上方出现 `批注页面`；
- 点选元素 → 出现 sheet 编辑器 → 写批注 → 发送 → agent 收到 Browser comments 上下文；
- 刷新页面 / 站内跳转后确认标记与 channel 重建正常。

**当前状态：已做 A（软链），等你重启验证。**

```sh
# 已完成（2026-10-20 23:51）：
cd ~/.dsh/profiles/desktop/node_modules
# 原 1.0.3 目录 → dsh-web-review.bak-20261020-235156
ln -s /Users/gcssloop/WorkSpace/AIGC/DSH/dsh-web-review/packages/dsh-web-review dsh-web-review
```

软链已指向本 checkout（含刚构建的 `lib/index.js` / `lib/client.js` / `lib/bridge.js`，
banner id 均为 `dsh-web-review`，与 profile 的 bundle row 同名）。

**客户端启动后会验证什么（按顺序）：**

1. 打开右侧「浏览器」Tab，加载任意 http(s) 页面（`pnpm demo` 的 5173 或外网站点都行）；
2. composer 上方应出现 `批注页面` 按钮（没有页面时不显示 = 说明没找到 guest，需排查）；
3. 点击后 URL 出现在同一行，页面进入拾取模式（悬停有蓝框）；
4. 点一个元素 → composer 上方弹出 sheet 编辑器（评论输入 + 选择/调整）；
5. 写评论确认 → 变成编号标记 + 胶囊；点 `发送` → agent 应收到 Browser comments；
6. 刷新页面 → 重新注入（新 channel），标记按 cssPath 复原。

**回滚：**

```sh
cd ~/.dsh/profiles/desktop/node_modules
rm dsh-web-review
mv dsh-web-review.bak-20261020-235156 dsh-web-review
```

注意：`desktop` profile 由 Electron 管理，客户端更新或插件管理器操作会覆盖这条软链；
长期用插件管理器装正式版本更稳（发布后 `dsh-web-review@1.1.x`）。

### 2. 死代码清理

`src/client/sidebar/PreviewTab.tsx`（1025 行）与 `preview-session.ts` 的客户端出口
现在无人调用，只是因为 `tests/panel.spec.tsx` 还在测它而保留。清理时要一起处理：

- `tests/panel.spec.tsx` 的 `PreviewTabBody` 用例（可整体删除或只留 dock 用例）；
- `tests/webview.e2e.spec.ts` / `tests/e2e-scaffold.ts` 里的预览 Tab 步骤；
- `src/client/index.ts` 末尾的 `createPreviewSession` / `releasePreviewSessions` 再导出。

### 3. 编辑器 sheet 的尺寸细节

`AnnotationEditor` 的 docked 顶边拖拽逻辑（`resize` 的 `edge === 'n'` 分支）在本轮之前就基本退化：
`position` 固定 `{0,0}` + `bottom = size.height`，拖动只会在 8px 附近抖动。
现在 sheet 高度由 `AnnotationDock` 的 `sheetHeight` 状态驱动，拖拽只做近似；
如果用户抱怨，就在 dock 侧接管尺寸（让 editor 只报 `onSizeChange`，不参与换算）。

### 4. 已知限制（写进 README 前先别当 bug 修）

- **Web 模式（`dsh web` + 浏览器）不可批注**：那里的「浏览器」Tab 是 cross-origin `<iframe>`，
  父页面无法注入脚本。桌面客户端才有 webview。UI 在 Web 模式下不会显示 `批注页面`（找不到 guest）。
- 多个 Browser 标签时按“可见矩形”选一个；多会话窗口同时显示两个 dock 的极端情况未处理。
- 页面脚本替换 `console` 不影响本方案（用队列）；但页面如果冻结/阻塞主线程，轮询会变慢。
- 站点若禁止被嵌入（`X-Frame-Options`）在 webview 里不受影响（webview 不是 iframe），这是相对
  插件旧代理模式的一个改善；但主进程会拦非 http(s) 导航。

## 有用命令

```sh
# 组件组合校验（不会启动服务）
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh --profile <name> --dump-config

# 起一个隔离实例做端到端验证（日志里有带 token 的 URL）
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh --profile <name> --port 54999 --no-open

# 插件全量校验 / 单文件测试
cd /Users/gcssloop/WorkSpace/AIGC/DSH/dsh-web-review && pnpm check --fast
pnpm exec vitest run packages/dsh-web-review/tests/browser-dock.spec.tsx
```

## 注意

- `dsh plugin` 会转发给 pnpm，因此 **pnpm 必须在 PATH**（内置 node 不含 npm/pnpm）。
- 插件仓库仍是 alpha.5 基线构建；0.2.x 客户端能加载，但改 slot/store 相关代码时要重新回归。
- 回滚：`~/.dsh/profiles/desktop/package.json.bak-20261020-223623`（去掉插件那次的备份）。
