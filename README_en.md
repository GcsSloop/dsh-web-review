# dsh-web-review

[简体中文](./README.md)

> ⭐ If you find this project helpful, please consider giving it a Star! Your support motivates me to keep maintaining and improving it.

Select page elements in the built-in browser as you would in a design tool, leave feedback, and preview changes to text, colors, typography, dimensions, spacing, borders, and effects. Once submitted, the agent uses your page annotations to update the source code in the current workspace.

<p align="center">
  <img width="100%" alt="dsh-web-review page preview, element annotations, and visual adjustments demo" src="./docs/assets/web-review-demo.gif" />
</p>

<p align="center">
  <img width="49%" alt="dsh-web-review page preview" src="./docs/assets/web-review-preview.jpg" />
  <img width="49%" alt="dsh-web-review element annotation and property editor" src="./docs/assets/web-review-annotation-editor.jpg" />
</p>

> If you have used the built-in browser in coding-agent apps such as v0 or Codex, this should feel familiar.

## Installation

### 1. Install the desktop shell

Download the installer for your platform from
[deepseek-harness-desktop Releases](https://github.com/GcsSloop/deepseek-harness-desktop/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `DeepSeek.Harness_<version>_aarch64.dmg` |
| Windows (x64) | `DeepSeek.Harness_<version>_x64-setup.exe` (or the matching `.msi`) |

The shell bundles its own Node runtime and the Harness itself, so nothing else
needs to be installed. The plugin also works without the shell; it simply loses
the in-shell native panel and falls back to the real-browser (CDP) or proxy
transport.

### 2. Install the plugin

`dsh plugin` forwards its arguments to pnpm, so **pnpm must be on PATH** (the
shell's bundled Node ships neither npm nor pnpm):

```sh
brew install pnpm          # macOS
# or anywhere: npm i -g pnpm
```

Then install through the shell's own bundled runtime — no global `dsh` needed.

macOS:

```sh
app="/Applications/DeepSeek Harness.app"
"$app/Contents/Resources/resources/node/bin/node" \
  "$app/Contents/Resources/resources/harness/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add dsh-web-review
```

Windows (PowerShell; the default install root is `%LOCALAPPDATA%\DeepSeek Harness` —
adjust `$app` if you installed elsewhere):

```powershell
$app = "$env:LOCALAPPDATA\DeepSeek Harness"
& "$app\resources\node\node.exe" `
  "$app\resources\harness\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web add dsh-web-review
```

> If `dsh` is already on your PATH (`npm i -g @deepseek-ai/dsh`), plain
> `dsh plugin --profile web add dsh-web-review` is exactly equivalent.

### 3. Start

Open the desktop shell: it starts the local Harness service and opens the Web UI
on its own, so there is no need to run `dsh web` by hand.

## Usage

1. Ask the AI to start the frontend page you want to review, then click the URL it returns: the preview opens in the right Sidebar.
   Alternatively, pick **Web preview** from the right Sidebar's guide page and enter an absolute HTTP(S) URL.
2. Click the annotation button at the end of the address row, then select the target element on the page.
3. Enter your feedback. To preview visual changes, expand **Adjust** and edit the desired properties.
4. Click the Send button in the annotation toolbar. You can also add more instructions in the DSH composer and use the regular DSH Send button; the annotations will be sent together with your prompt.
5. After the agent updates the source code, refresh the preview to review the result. Continue annotating if further changes are needed.

## Features

### Web Preview

- The preview is a page tab in the right Sidebar: it follows the column's open and closed state, and switching tabs keeps the page alive.
- Back, forward, reload, and an address field, so browsing behaves like a browser.
- The annotation editor docks at the bottom of the pane, sharing it with the page instead of covering it.

### Element Annotations

- Hover to highlight page elements and click to select them.
- Add annotations to multiple targets.
- Automatically include selectors, text, accessible names, and source clues to help the agent locate the corresponding implementation.

### Live Visual Adjustments

- Edit text, colors, fonts, font sizes, line heights, dimensions, and opacity.
- Adjust spacing, layout, borders, corner radii, and effects.
- Preview every change immediately.

### AI Collaboration

- Annotations are injected as independent context alongside your prompt.
- Page comments use DSH's native transcript disclosure: page and count when collapsed, then targets, intent, before/after values, and available source clues when expanded.
- The agent updates source code in the current workspace; temporary page adjustments do not modify project files directly.

### UI Design Skills

The plugin includes [Jakub Krehel's design skills](https://github.com/jakubkrehel/skills):

- `better-ui`
- `better-typography`
- `better-layout`
- `better-writing`
- `better-accessibility`
- `better-colors`
- `better-interface`
- `interface-review`

Invoke a skill with a slash command, or select one in the annotation editor so the agent can apply its guidance during the current iteration.

## Plugin Capability Evaluation

The project includes an evaluation suite based on the real annotation workflow. It verifies whether an agent can locate the relevant source code and complete frontend changes after receiving page annotations generated by the plugin.

The suite covers:

- Copy, styling, layout, and responsive changes.
- Multi-element and related multi-requirement changes.
- React, Vue, and static pages.
- Source localization with and without source anchors.
- Semantics and accessibility requirements.
- Multi-round annotations and edit-scope ownership.
- Token usage, execution steps, and runtime.

See [Eval suite](./eval/README.md) for the evaluation design, commands, and guidance on interpreting results.

## Origin and Dependencies

- This project is forked from [CanglongCl/dsh-web-review](https://github.com/CanglongCl/dsh-web-review); thanks to the upstream author.
- The desktop `native` preview mode (the in-shell WKWebView panel) requires the [deepseek-harness-desktop](https://github.com/GcsSloop/deepseek-harness-desktop) shell; without it, preview falls back to the real-browser (CDP) or proxy transport.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, architecture notes, and verification workflows.

See [CHANGELOG.md](./CHANGELOG.md) for the version history.
