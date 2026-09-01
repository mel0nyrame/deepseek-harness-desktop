# Agent Note: Desktop fork identity and upstream README preservation

Status: implemented

English | [中文](2026-08-16-desktop-fork-identity-and-upstream-readme-preservation.zh.md)

## Problem

The repository ships the DSH Desktop Electron product, but the root homepage presented the checkout solely as the upstream DeepSeek Harness CLI and Web project. Rewriting that homepage without preserving it would erase the provenance and onboarding text inherited from the project this repository directly extends.

## Decision

The root [README](../../../../README.md) identifies the repository as `deepseek-harness-desktop` and the application as DSH Desktop. It describes Electron as the product-specific layer while retaining DeepSeek Harness as the bundled core with its existing package names, CLI identity, architecture, and documentation vocabulary.

The previous English README, Chinese README, and consistency record are retained under `archive/` as [English](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/archive/deepseek-harness-readme.md), [Chinese](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/archive/deepseek-harness-readme.zh.md), and [pairing-record](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/archive/deepseek-harness-readme-pairing-record.yaml) snapshots. The record uses a descriptive archival filename rather than the active `.i18n.yaml` suffix because archived snapshots are outside the evolving documentation pairing corpus. Their language switchers and repository-relative links resolve from the archive location; the project and onboarding content remains unchanged. The new homepage links both local README snapshots and the [upstream repository](https://github.com/deepseek-ai/deepseek-harness). Core harness documentation stays in place and is not renamed into desktop terminology.

The homepage derives its visual system from the shipped client's light-theme tokens and macOS window contract. A real installed-app renderer capture provides the primary proof; separate spot illustrations explain bundled runtime, private carrier, native workspace, and shared-state roles; a standalone diagram owns the process architecture. Editable SVG, generation prompt, style specification, raw sheet, and source capture stay beside the published assets so the visual claims remain inspectable and reproducible.

## Alternatives considered

**Rewrite the upstream homepage in place without an archive.** This would make the desktop entry concise, but it would discard the exact project description and onboarding material inherited by the fork.

**Rename every DeepSeek Harness reference to DSH Desktop.** This would blur the boundary between the Electron product and its bundled runtime, while breaking valid package, CLI, architecture, and ecosystem names.

**Link only to the remote upstream repository.** A remote link preserves attribution but not the exact README snapshot from which this desktop repository diverged.

## Consequences

The repository homepage now leads with the desktop product, shows real product evidence before implementation detail, and sends core-runtime readers to the existing DeepSeek Harness documentation. The archived snapshots are provenance records rather than active documentation pairs; future desktop copy changes update the root README pair, while any intentional upstream snapshot refresh replaces all three archived files together and records the source revision in the same change.
