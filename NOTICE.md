# 来源与修改记录

CanvasSaveGuard 画布助手的扩展代码和适配修改由 YCQ 维护。公开版本 1.0.42 于 2026-11-17 发布，整体按 AGPL-3.0-only 分发。

## Infinite Canvas v0.4.0

- 项目为 `basketikun/infinite-canvas`，原作者及贡献者保留其版权。
- 原始源码固定在提交 `973d14f4c35a408019cd53797732c9dc9132022d`，对应标签 `v0.4.0`。
- 源码子模块位于 `upstream/source-v040`，可通过 `git submodule update --init` 获取。
- 原始编译资源为 `upstream/canvas-client-v040.original.js`，SHA-256 为 `889e42fb3b1871e347252e4cea6bba8092e16bd66edeacba80413b455f3a34f2`。
- 补丁修改位于 `scripts/build.mjs` 及其引用的 `src/` 模块，生成 `extension/patches/canvas-client-v040.js`。
- 完整 AGPLv3 文本保留于 `UPSTREAM_LICENSE.txt`。

[上游固定源码](https://github.com/basketikun/infinite-canvas/tree/973d14f4c35a408019cd53797732c9dc9132022d)

## Infinite Canvas v0.20.0

- 项目为 `basketikun/infinite-canvas`，Copyright (c) 2026 basketikun。
- 原始源码固定在提交 `3a6b64b602ad062b29fac66902ed18a7ef5fd9dc`，对应标签 `v0.20.0`。
- 源码子模块位于 `upstream/source-v020`，可通过 `git submodule update --init` 获取。
- 原始编译资源为 `upstream/canvas-client-v020.original.js`，SHA-256 为 `d945e49e52ee3a8636b3ee9f2ede5f7b851dbb8fcf665d08a24f91fd70f6ceeb`。
- 补丁修改位于 `scripts/patch-v020.mjs` 及其引用的 `src/` 模块，由 `scripts/build.mjs` 生成版本化产物。
- 完整 MIT 文本保留于 `UPSTREAM_V020_LICENSE.txt`。

[上游固定源码](https://github.com/basketikun/infinite-canvas/tree/3a6b64b602ad062b29fac66902ed18a7ef5fd9dc)

## 修改范围

适配修改涵盖保存与恢复接口、媒体文件保护、明确删除记录与撤销期、图片组展示及连线、选择和拖动、布局、失败项重试及批量图片下载。详细记录见 `使用说明.md`，可编辑源码与构建脚本随仓库提供。

## 其他组件

fflate 用于 ZIP 处理，Copyright (c) 2020 Arjun Barrett and contributors，按 MIT 许可分发。其许可文本保留于 `THIRD_PARTY_NOTICES.txt`。esbuild、Playwright 和 fake-indexeddb 用于构建或测试，版本锁定于 `package-lock.json`，各自保留其许可证。
