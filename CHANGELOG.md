# Changelog

All notable changes to `dsh-web-review` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-18

### Changed

- **webview:** restore the state.url-driven preview loading
- one preview tab per page, and a session that heals itself
- make the right Sidebar the preview home, with annotation
- host the native panel in the right-Sidebar tab
- place the native panel and capture it natively
- drive the desktop shell's native browser panel
- never let the optional right-Sidebar host break the client
- host the preview in an optional right-Sidebar tab
- run the annotation bridge inside the real browser
- render browser-mode previews on a canvas surface
- serve browser-mode preview sessions over CDP and SSE
- add the dependency-free CDP transport for real-browser preview

### Fixed

- **webview:** a page redirect must never change the session target
- **webview:** create a preview session even while its tab is not yet marked visible
- **webview:** stop page redirects from flickering or freezing the preview
- **webview:** keep each preview tab's page and panel to itself
- **webview:** stop the preview from re-creating its session on every render
- **webview:** make the transport ladder actually fall back, and name the proxy
- **webview:** fall back to a single page tab when a host refuses the address
- **bridge:** install the picker when the bridge runs before any element exists
- **webview:** keep a legacy preview tab on the page it was showing
- **webview:** keep the panel rect honest when the pane only moves
- **webview:** deliver panel messages over the shell handler, and stop orphaning the panel
- **webview:** release a session the tab replaced instead of letting it idle
- **webview:** keep the native panel rect in step with the host layout
- **webview:** carry the bridge artifact's own message over the native sink
- **webview:** make typing work and keep an idle preview sharp
- **webview:** render path-aware and login-gated pages in Preview

### Internal

- **release:** rename package to dsh-web-review and freeze v1.0.0
- **webview:** surface the in-flight transport and the exact failure
- **webview:** flag the browser suite's unrun sidebar entry step
- **webview:** document the right-Sidebar preview home
- record the real-browser transport and the right-Sidebar tab

## [0.6.0] - 2026-09-05

## [0.6.0-beta.0] - 2026-09-02

### Changed

- migrate the client and node seams to the alpha.5 host
- render browser comments via the rc.8 snapshot context form

### Internal

- relabel harness-cli spec to the alpha.5 baseline
- relabel the harness baseline to alpha.5
- alpha.5 token boot, contenteditable composer and chat flows
- run the source-checkout channel under the real package name
- pin the @deepseek-ai development cohort to 0.1.2-alpha.5
- relabel remaining test comments to the rc.8 baseline
- relabel the reviewed harness baseline to rc.8
- acknowledge by snapshot id and assert rc.8 context rows
- pin the @deepseek-ai development cohort to 0.1.0-rc.8
- add the oh-my-dsh plugin-upgrade skill for DSH host migration

## [0.5.0] - 2026-08-26

## [0.5.0-beta.1] - 2026-08-25

### Added

- render browser comments via the rc.8 snapshot context form

### Internal

- remove page snapshot archival feature
- replace page snapshot archival with dsh-better-sidebar integration
- better-sidebar note in README and 0.5.0-beta.1 changelog entry
- accept acknowledged snapshots by id advancement, not the syncing transition
- keyless-by-design runtime, rc.8 fold-row assertions, and sidebar tab render fixes
- derive the web-review line onto main (rc.8 + better-sidebar + rc.8 adaptations)

## [0.4.1-beta.1] - 2026-08-24

### Internal

- add GitHub release creation and changelog generation

## [0.4.1-beta.0] - 2026-08-20

### Changed

- bind annotation context to the queued user message

### Internal

- align welcome notice acknowledgement to the reviewed baseline

## [0.4.0-beta.0] - 2026-08-20

### Changed

- bind annotation context to the queued user message
- archive page snapshots (HTML tree + screenshot) on annotated sends

### Internal

- align welcome notice acknowledgement to the reviewed baseline
- numbered report archives with commit hash inside the report
- archive combined long-task A/B report (f11362b cohort)
- combined multi-target long tasks (todo/shop/landing/forms combos)
- snapshot A/B arm, per-run token attribution, versioned report archive

## [0.3.0] - 2026-08-17

## [0.3.0-rc.2] - 2026-08-17

### Internal

- declare dsh.bundle patch in source package for installability

## [0.3.0-rc.1] - 2026-08-17

### Fixed

- **client:** restore current-row emphasis and finish dark-mode tokenization
- **client:** adapt annotation editor and element selector to dark mode using theme tokens

### Internal

- add npm beta channel (beta dist-tag + release:beta script)
- automate README screenshots and demo GIF regeneration

## [0.2.0] - 2026-08-14

### Added

- return to chat after annotation send

### Changed

- render browser comments as native context
- focus comment input after element pick

### Internal

- preserve npm trusted publishing auth
- install Chromium for release checks
- introduce plugin evaluation suite
- report plugin task acceptance
- restructure report around experiment comparison
- simplify report language
- open harvested sessions in DSH Web
- report the latest runtime cohort
- support published DSH runtime
- show annotation-backed task descriptions
- contain report table overflow
- flag runs that exceed token budgets
- isolate model runs and calibrate semantic checks
- use npm trusted publishing
- refresh capture verification provenance
- record headline capture verification
- harden causal design and semantic grading
- ask readers to star the project
- ask readers to star the project
- calibrate qualitative smoke graders
- calibrate grading and localize reports
- integrate expanded protocol smoke bank
- add plugin capability comparison suite
- batch assertions, menu adjust capture, tolerant task loading for concurrent authoring
- rebase machinery onto harness 0812 baseline, add smoke task filter
- track restoration of harness 0812 npm types
- migrate to harness 0812 contracts
- pilot end-to-end — pre-step injection fidelity, chunk-usage stats, provider baseline, fixture hygiene
- add W0 machinery — question bank, real-GUI capture, headless runner, grader, session stats, HTML report
- add frontend modification eval suite plan

## [0.1.0] - 2026-08-13

### Changed

- native browser context injection and annotation dock
- preview as a conversation tab with send-time annotation injection
- annotation message becomes English hints-only, empty comments omitted
- location-oriented, framework-agnostic annotation prompt
- keep picked-element outline; XML annotation prompt with full DOM path
- annotation interaction redesign (comment-first, marker echo)
- fix scope-addressed send ('cannot get property conversation without inject')
- restyle panel with the dsh design system
- webview panel + element annotation + AI-driven edits

### Fixed

- restore assistant link preview routing

### Internal

- trust reviewed release lockfile
- use public DSH npm packages
- add English README
- streamline user-facing README
- prepare public npm installation guide
- separate user and contributor guides
- add npm 0.1.0 release plan
- publish package publicly
- add local tarball installation smoke test
- publish privately under canglongcl
- use private npm development packages
- release 0.0.4-rc.2
- add target ownership and text identity to annotation context
- add built-in UI skills
- add private npm release workflow
- isolate remote previews by origin
- add element tree scroll affordance
- align acceptance launcher with 0811
- support harness 0811 contracts
- add movable resizable annotation editor
- add CSS keyword menus and acceptance history
- harden TypeScript boundaries
- ignore absent-agent clears
- refine corner radius glyphs
- release v0.0.3
- animate element selection feedback
- add README demo
- add local release packaging
- bump version to 0.0.2
- add element hierarchy selector
- redesign spacing controls
- focus property scrubbing and hide editor chrome
- add official DSH bundle installation
- preserve credentials in isolated previews
- support harness 0810 contracts
- add visual web review workflow
- TypeScript-only repo, e2e suite, git hooks and quality gates

[1.0.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.6.0-beta.0...v0.6.0
[0.6.0-beta.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.5.0...v0.6.0-beta.0
[0.5.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.5.0-beta.1...v0.5.0
[0.5.0-beta.1]: https://github.com/GcsSloop/dsh-web-review/compare/v0.4.1-beta.1...v0.5.0-beta.1
[0.4.1-beta.1]: https://github.com/GcsSloop/dsh-web-review/compare/v0.4.1-beta.0...v0.4.1-beta.1
[0.4.1-beta.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.4.0-beta.0...v0.4.1-beta.0
[0.4.0-beta.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.3.0...v0.4.0-beta.0
[0.3.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.3.0-rc.2...v0.3.0
[0.3.0-rc.2]: https://github.com/GcsSloop/dsh-web-review/compare/v0.3.0-rc.1...v0.3.0-rc.2
[0.3.0-rc.1]: https://github.com/GcsSloop/dsh-web-review/compare/v0.2.0...v0.3.0-rc.1
[0.2.0]: https://github.com/GcsSloop/dsh-web-review/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/GcsSloop/dsh-web-review/commits/v0.1.0
