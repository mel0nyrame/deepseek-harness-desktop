# Agent Note: 离线且区分所有权的桌面配置引导

Status: implemented

[English](2026-08-20-offline-desktop-profile-bootstrap.md) | 中文

## 问题

桌面产品需要由内嵌的官方包与桌面包组装一个名称稳定的配置，且启动时不依赖源码检出或网络。若把完整配置清单视为产品生成状态，修复会覆盖用户安装的插件与无关配置；若接受过期的产品条目，则可能启动不兼容或只有基础功能的插件树。

## 决策

桌面组合包拥有 `desktop` 配置中的有序产品前缀：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与 `@dsh-desktop/bundle`。它还在 `dsh.desktop.components` 下记录内嵌组件的精确版本，并保持 Loader 的 `cordis.yml` 组合根为空。引导程序在写入前验证所有组件，创建缺失的配置支持文件，并且只修复这些产品所有状态。产品前缀之外的组合包、依赖项、其他清单键，以及已有的 `cordis.patch.yml` 均归用户所有。

桌面组合包补丁禁用浏览器所有的启动条目，并追加桌面连接、原生能力与 UI 提供方。`composeDesktopProfile()` 通过已发布的 profile loader 解析生成的 manifest 与每个内嵌组合包，再返回有效 Loader 条目及由等同启动路径的 patch 算法生成的配置 dump。应用生命周期接线仍由 tracer-bullet 集成阶段负责；组合包拥有接线方调用的引导操作与组合策略。

## Verification

`pnpm exec vitest run tests/profile-bootstrap.test.ts` 的全部十一项聚焦引导与真实组合检查通过，工作区也通过 `pnpm run typecheck`。

## 曾考虑的替代方案

**用模板替换完整配置。** 否决：修复会破坏用户安装的插件、patch 原始字节及无关配置。

**接受任意可解析的组合包版本。** 否决：应用可能内嵌彼此不兼容的官方包，并在之后以间接的 Loader 错误失败。

**组件缺失时回退到基础组合包。** 否决：部分配置会隐藏安装损坏，并产生缺少预期 Web 与桌面能力的产品。

## 后果

全新的 home 可以完全通过内嵌包初始化；已有效的配置再次引导时不会写入任何文件。格式错误的 JSON 与非对象 manifest 会保持不变并产生包含路径的诊断；无法解析或版本不兼容的组件会在创建配置前被明确指出。专项测试覆盖创建、幂等、修复、用户所有 JSON 字节、格式错误状态、组件失败，以及经 profile loader 真实组合的条目顺序与配置 dump。
