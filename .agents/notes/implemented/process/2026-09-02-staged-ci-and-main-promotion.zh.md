# Agent Note: 按变更风险分级的 CI 与主干晋升

Status: implemented

[English](2026-09-02-staged-ci-and-main-promotion.md) | 中文

## 问题

解耦议题 #62–#72 要把仓库默认分支变成独立的桌面产品。在此之前，本仓库只有一条 CI 工作流：无论改动内容是什么，每个 pull request 都要支付完整的 macOS 打包门禁；这里也不存在 release 级的 arm64/x64 签名、公证与 release 证据层；把解耦后的工作区晋升为默认分支所需的行为 parity、真实 API 验收与回滚证据均无记录。

## 决策

CI 按变更风险分为三个工作流：

- **`ci.yml` —— 普通 pull request。** 冻结安装、typecheck、lint 与完整的行为测试套件（Linux）。套件包含仓库布局边界测试，它锁定 Agent Note 树、保留的 skills、agent 文档与产品身份资产，因此文档检查与同一 job 一起运行。该 job 不做打包。
- **`packaging.yml` —— 应用产物相关变更。** 运行时闭包校验、macOS 包构建，以及在源码树之外对已安装应用执行冒烟。当 pull request 改动打包相关路径（`apps/**`、`packages/**`、`runtime/**`、`scripts/**`、`patches/**`、`tests/fixtures/**`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 与工作流自身）时运行；`master` 的每次推送都重新验证晋升状态；`workflow_dispatch` 覆盖手动触发。它不引用任何 secret。
- **`release.yml` —— release pull request 与标签。** 每个架构一个原生构建的产物：arm64 使用 `macos-15`，x64 使用 `macos-15-intel`。带 `release` 标签的 pull request 产出 ad-hoc 签名的预览产物，以 SHA-256 校验和与打包日志作为证据，并且拿不到任何 secret。版本标签（`v*`）与手动触发产出 Developer ID 签名并公证的产物；未配置签名或 Apple 凭据时该 job 直接失败。工作流从不发布 GitHub release。

Release 签名通过 `DSH_DESKTOP_SIGN_IDENTITY` 进入打包流程（[`scripts/release-signing.ts`](../../../../scripts/release-signing.ts)）。未设置时，打包保持与提交一致的 ad-hoc 形态。设置后，它覆盖 electron-builder 的签名身份，启用 Developer ID 分发与公证所要求的 hardened runtime，并只把声明的凭据名（`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`）重新放行越过打包脚本默认的凭据清洗，使其到达 electron-builder 而非其他任何地方；真实身份同时使 Gatekeeper 评估成为硬门禁。Release 模式拒绝 ad-hoc 标记 `-`。凭据只存在于 Actions secrets（`MAC_SIGNING_IDENTITY`、`MAC_CERTIFICATE_P12`、`MAC_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`），真实 API 密钥不进入任何工作流。

`tests/ci-staging.test.ts` 锁定分级契约——job 集合、路径门禁、触发条件、架构矩阵、secret 边界与 fail-closed 凭据守卫——工作流漂移会让普通套件失败。晋升证据保存在双语的[晋升文档](../../../../docs/promotion/promotion.md)：带精确记录结果的行为 parity 终表、受保护的手动真实 API 验收命令及其证据位置，以及晋升清单（legacy 分支、迁移基线 tag、基于 revert 的回滚、精确运行时清单、无 force-push 要求）。

## 验证

`pnpm run check` 在 macOS arm64 上通过（含分级套件），本地打包门禁端到端通过：`pnpm run package` 之后运行 `DSH_DESKTOP_PACKAGE_REQUIRED=1 pnpm run test:package`，ad-hoc 身份、Gatekeeper 裁决按证据记录（ad-hoc 签名必然被拒），自有进程零存活。精确命令与结果记录在晋升文档中。签名 release 层有意保持未演练：在配置 Apple 凭据之前，凭据守卫会让标签构建失败，而不是默默产出 ad-hoc 产物。

## 已考虑的替代方案

**保留单一工作流，让每个 pull request 都跑打包 job。** 拒绝：macOS 门禁是最昂贵的一层，纯文档或包外改动从中得不到任何东西；而 release 签名绝不能与 pull request 触发面共享。

**在一个 arm64 runner 上交叉编译两个架构。** 拒绝：运行时闭包按宿主架构部署原生依赖，在外来架构的 Electron 下做原生 ABI 校验会引入未测路径。每个架构一个原生 runner 原样复用已验证的打包门禁。已知的 Intel runner 风险——GUI 旅程中的焦点编排挂起，由 legacy release 工作流记录——是首次 x64 运行的具名覆盖缺口。

**把签名 job 放在带必需审批人的 GitHub environment 之后。** 暂缓：environment 及其保护规则属于维护者策略选择；标签/条件加 fail-closed 凭据守卫已经钉住 secret 边界，同时不阻塞自动化。

## 后果

普通 pull request 保持在 Linux 快速层，打包成本跟随打包风险，release 证据以仅凭据不同的两层存在。签名层在配置 Apple 凭据之前处于已定义但未演练状态；届时之前，标签构建会在凭据守卫处失败而不是默默交付 ad-hoc 产物。x64 腿尚未在本仓库运行，并继承 legacy 工作流记录的 Intel runner GUI 风险。
