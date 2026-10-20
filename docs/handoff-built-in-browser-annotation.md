# 交接：把批注接到官方客户端的内置浏览器

> 状态存档于 2026-10-20。新会话读这一份即可继续，无需翻历史。

## 目标

`dsh-web-review` 原本自带「网页预览」Tab（插件自己的预览传输 + 拾取器 + 编辑器）。
用户已切到**官方 Electron 客户端**，希望：

1. **删掉插件自己的「网页预览」Tab**（已完成）；
2. **把元素拾取 / 批注直接挂在客户端内置的「浏览器」Tab 上**（未完成）。

## 环境事实（都已实测确认）

| 项 | 值 |
|---|---|
| 客户端 | 官方 Electron 版 **0.2.1-rc.2**，`/Applications/DeepSeek Harness.app` |
| 运行 profile | `~/.dsh/profiles/desktop`（进程参数可验证） |
| profile 管理 | **CLI 拒绝管理 `desktop`**：`error: profile "desktop" is managed exclusively by the Electron application` |
| 内置 node | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`（v24.21.0） |
| 内置 pnpm | 同目录 `.../dependencies/pnpm/bin/pnpm.mjs`（v11.28.5） |
| CLI 入口 | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` |
| 读取 asar 内文件 | `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e '<script>'` |
| 内置浏览器 kind | `"browser"`（`BROWSER_KIND`），id `@deepseek-ai/dsh-client-ui-sidebar-browser` |

### 内置浏览器的实现（关键）

它是 Electron `<webview>`，创建参数：

```js
element.dataset.sidebarBrowserFrame = "webview";
element.setAttribute("name", reservation.lease);
element.setAttribute("partition", reservation.partition);
element.setAttribute("allowpopups", "");
element.setAttribute("src", "about:blank#" + reservation.lease);
```

- **没有 preload**（源码里 `preload` 出现 0 次）→ 不能用 `ipcRenderer.sendToHost` / `ipc-message`。
- 宿主 → 页面只能用 `webview.executeJavaScript(...)`。
- 页面 → 宿主只能用 `webview.addEventListener('console-message', ...)`（桥用带前缀的 `console.log` 发出 JSON）。

### 兼容性结论（已验证，不必重查）

插件声明的 `inject` 里有 `@deepseek-ai/dsh-client-ui-slots` / `-primitives`，它们在 0.2.1-rc.2 里**没有独立 node_modules 包，但仍是运行时平台模块**（官方自己的包也在 `require` 它们）。
实证：把 1.0.3 装进测试 profile 后启动实例，**零 console 错误**，插件客户端进了 application 预加载批次，节点半路由 `POST /webview-preview-sessions` 返回 415（已注册）。

## 已完成

- 提交 `e2c1729`（分支 `release/v1.0.0`）：`refactor(client): drop the plugin's own preview tab and reveal the built-in Browser`
  - 删除 [`src/client/index.ts`](../packages/dsh-web-review/src/client/index.ts) 里对 `registerSidebarPreviewTab` 的调用；
  - `openPreview` 改为 `ctx.sidebarRight?.openTab('browser', { params: { url } })`；
  - 清掉因此失效的 `scopedConversation` / `isClientSessions`。
  - `tsc -b --force` 与 `pnpm check --fast` 全绿。
- 线上最新发布版本仍是 **1.0.3**（含旧的预览 Tab）；**本地已装进 `desktop` profile 的也是 1.0.3**。所以用户界面暂无变化。

## 待完成（按此顺序）

### 1. `webviewCarrier`

在 [`preview-bridge.ts`](../packages/dsh-web-review/src/client/preview-bridge.ts) 增加一个实现现有 `PreviewCarrier` 的载体：

```ts
export function webviewCarrier(element: Electron.WebviewTag): PreviewCarrier
```

- `post(message)`：`element.executeJavaScript('__dshWebReviewReceive(<json>)')`（注意 JSON 转义）。
- `subscribe(handler)`：监听 `console-message`，只认带前缀的 payload。

### 2. 注入控制器 `browser-annotation.ts`

- 定位：`document.querySelectorAll('webview[data-sidebar-browser-frame="webview"]')`，多标签时取可见（`offsetParent !== null` / rect 非零）。
- 时机：`dom-ready`、`did-navigate` 后注入 bootstrap + 构建好的 `lib/bridge.js`。
- 驱动 `PreviewBridgeClient`（构造参数见 [`preview-bridge.ts:157`](../packages/dsh-web-review/src/client/preview-bridge.ts)）。
- `onPick` → store 的 `addPick`；后续 `updateComment` / `removePick`。

### 3. 浮层编辑器

复用 [`AnnotationEditor.tsx`](../packages/dsh-web-review/src/client/AnnotationEditor.tsx)：

- 需要一个容器元素作为 `frame` prop；按 webview 的 `getBoundingClientRect()` 绝对定位（参考 [`floating-position.ts`](../packages/dsh-web-review/src/client/floating-position.ts)）。
- 约 15 个 props 目前都取自 `PreviewTabBody` 内部事务状态，需要抽出共享状态层。
- **精简选项**：先只做「点选 + 写批注」，不做实时样式调整面板，可省掉大半个事务状态。

### 4. 发布与安装

```sh
# 1) 升版本 + changelog + tag（沿用既有流程）
# 2) 安装进 desktop profile（CLI 不认 desktop，直接改 manifest + 内置 pnpm）
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
cd ~/.dsh/profiles/desktop            # package.json 里 dependencies + dsh.profile.bundles 都要加
"$NODE" "$PNPM" install --config.node-linker=hoisted
# 3) 完全退出并重开客户端
```

回滚：`~/.dsh/profiles/desktop/package.json.bak-20261020-223623`（去掉插件那次的备份）。

## 有用命令

```sh
# 组件组合校验（不会启动服务）
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh --profile <name> --dump-config

# 起一个隔离实例做端到端验证（日志里有带 token 的 URL）
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh --profile <name> --port 54999 --no-open
```

## 注意

- `desktop` profile 由 Electron 管理，手改 manifest 可能被覆盖；官方客户端自带**插件管理器 / 插件市场**（设置里），是更稳的安装入口。
- `dsh plugin` 会转发给 pnpm，因此 **pnpm 必须在 PATH**（内置 node 不含 npm/pnpm）。
- 插件仓库仍是 alpha.5 基线构建；拿到 0.2.x 客户端上能加载，但改动 slot/store 相关代码时要重新回归。
