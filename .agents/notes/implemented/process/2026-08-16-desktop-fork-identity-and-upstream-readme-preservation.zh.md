# Agent Note: 桌面衍生项目身份与上游 README 保留

Status: implemented

[English](2026-08-16-desktop-fork-identity-and-upstream-readme-preservation.md) | 中文

## Problem

仓库已经交付 DSH Desktop Electron 产品，但根首页仍只把当前 checkout 描述为上游 DeepSeek Harness CLI 与 Web 项目。若直接重写而不保留原首页，就会抹去本仓库直接扩展的原项目所提供的来源与上手说明。

## Decision

根 [README](../../../../README.md) 将仓库标识为 `deepseek-harness-desktop`，将应用标识为 DSH Desktop。它把 Electron 描述为本项目专属产品层，同时保留 DeepSeek Harness 作为内置内核，并继续沿用现有包名、CLI 身份、架构和文档术语。

原英文 README、中文 README 与一致性记录作为快照保留在 `archive/` 下，分别为 [English](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/archive/deepseek-harness-readme.md)、[Chinese](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/archive/deepseek-harness-readme.zh.md) 和 [pairing-record](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/archive/deepseek-harness-readme-pairing-record.yaml)。归档快照不属于持续演进的文档配对语料库，因此记录使用描述性的归档文件名，而不沿用现行 `.i18n.yaml` 后缀。语言切换行和仓库内相对链接按归档位置解析，项目与上手内容保持不变。新首页同时链接两份本地 README 快照与[上游仓库](https://github.com/deepseek-ai/deepseek-harness)。harness 内核文档保持原位，不改写为桌面端术语。

首页视觉系统取自已交付客户端的浅色主题 token 与 macOS 窗口约定。真实安装态 renderer 捕获承担首要证明；独立 spot 插画分别解释内置运行时、私有载体、原生 Workspace 与共享状态角色；单独的架构图持有进程架构说明。可编辑 SVG、生成提示词、风格规范、原始 sheet 与源捕获和发布素材放在一起，使视觉主张保持可检查、可复现。

## Alternatives considered

**不归档，直接原地重写上游首页。** 这种方式能让桌面入口更简洁，但会丢失衍生项目继承的精确项目描述与上手资料。

**把所有 DeepSeek Harness 引用都改名为 DSH Desktop。** 这种方式会混淆 Electron 产品与其内置运行时的边界，还会破坏有效的包名、CLI 名称、架构名称和生态术语。

**只链接远程上游仓库。** 远程链接能保留署名，但不能保留本桌面仓库开始分化时对应的精确 README 快照。

## Consequences

仓库首页现在优先介绍桌面产品，在实现细节前展示真实产品证据，并把内核运行时读者引导到现有 DeepSeek Harness 文档。归档快照是来源记录而不是活跃文档配对；后续桌面端文案改动更新根 README 配对，而任何有意的上游快照刷新都必须同时替换三个归档文件，并在同一变更中记录来源修订版本。
