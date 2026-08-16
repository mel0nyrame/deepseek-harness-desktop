# Agent Note：桌面制品采用 ad-hoc 签名；Developer ID 公证仍受付费 Apple 账号门槛约束

Status: implemented

[English](2026-08-16-desktop-release-artifact-signing.md) | 中文

## Problem

Issue #9 要求产出签名并公证的 arm64 与 x64 桌面制品。公证是 Apple 的服务端流程，只有付费 Apple Developer Program 成员可以执行（App Store Connect API key 或 Apple ID 加 app 专用密码）；自签名、ad-hoc 或第三方方案都无法替代，因此在本项目不持有凭据的前提下无法逐字满足该 issue。此外还有两项与账号无关的缺口：打包流程没有 dmg 目标，也没有跨架构路径（脚本按主机 ABI 重建 node-pty，arm64 机器无法产出 x64 制品）。

## Decision

现在交付无需凭据的一档，付费一档保持只差一处配置的距离：

- **打包管线内 ad-hoc 签名** — `electron-builder.yml` 设置 `identity: '-'`（ad-hoc，无需 Apple 凭据）与 `hardenedRuntime: false`（硬运行时若缺少 `disable-library-validation` entitlement，会拒绝以 `ELECTRON_RUN_AS_NODE` 运行的子进程加载重建后的 node-pty addon）。目标改为 `dmg` 与 `dir`。yml 注释记录了未来 Developer ID 配置要填写的两个字段（identity 名称与 `notarize.teamId`）。
- **打包脚本内的证据门禁** — `scripts/artifact-evidence.ts`（由 `apps/desktop/tests/package.spec.ts` 单元测试）定义了每个产出制品在管线宣告成功前都要面对的检查：`codesign --verify --deep --strict` 与针对 dmg 的 `hdiutil verify` 是硬门禁，`codesign -d` 记录身份信息，`spctl --assess` 记录 Gatekeeper 结论——只有签名身份不是 `-` 时才会强制执行，因为 macOS 对 ad-hoc 签名（即使是本地未隔离构建）一律通过 spctl 拒绝。
- **跨架构交给 CI 矩阵** — `.github/workflows/desktop-release.yml` 在 `macos-26-intel`（x64）与 `macos-26`（arm64）上构建、签名、验证、跑完整打包应用套件（唯一覆盖 x64 的 lane）、挂载 dmg、对挂载后的制品跑 keyless 场景并上传 dmg，由 workflow_dispatch 与 `v*` 标签触发。只有 keyless 场景从镜像上运行：渲染器首次绘制的时序断言在只读 HFS 挂载上会闪断。构建器配置声明 `publish: null`——dmg 由 CI 作为运行产物上传——否则 electron-builder 的发布管理器会在 Actions runner 上自动探测 GitHub provider（环境里存在 `GITHUB_TOKEN` 即触发），在构建 dmg update-info 时索要凭据。矩阵刻意不做成 pull-request 门禁：现有 PR lane 已在一台 arm64 runner 上跑打包冒烟，矩阵会让私有仓库的 macOS runner 分钟数翻倍。
- **如实陈述 Gatekeeper 范围** — Gatekeeper 只评估带 quarantine 属性的启动：本地构建的制品打开时不被评估，而 `spctl --assess` 对一切 ad-hoc 签名一律拒绝，因此管线记录该结论而不强制执行。下载的副本带有 `com.apple.quarantine`，需要一次性右键 → 打开。Homebrew cask 分发会剥离 quarantine。要让下载副本零警告，需要 Developer ID 签名加公证；`spctl --master-disable` 永远不是分发方案。

## Alternatives considered

- **用 entitlements 取代 `hardenedRuntime: false`** — 保留硬运行时并附加 `disable-library-validation` 与 `allow-jit` entitlements 文件，可以让 ad-hoc 构建与未来的 Developer ID 构建形状一致。否决：没有可信身份时运行时加固毫无收益，entitlements 文件还会引入证据门禁必须承担的签名失败模式。
- **从 arm64 主机产出 universal（lipo）二进制** — 否决：node-pty 与其 `spawn-helper` 是分架构的原生构建，macOS 上跨架构 node-gyp 脆弱；CI 矩阵在两个架构上原生完成验证。

## Consequences

- 本地 `package` 运行产出已签名的 `.app` 与 `.dmg`，签名或镜像校验回退时会响亮失败；Gatekeeper 结论在接入 Developer ID 身份前保持为记录性证据。
- x64 制品依赖 CI 工作流（Intel runner）；arm64 在任何 arm64 主机上都能构建。
- `--skip-build` 与 `--dry-run` 两个标志此前从未生效：`parseArgs` 按原样报告带连字符的选项名，而脚本读取的是驼峰键，导致每次 CI 运行都会把工作区构建两遍。同一变更中修复，因为发布工作流的 `package:skip-build` 步骤依赖它。
- Issue #9 的公证部分由 issue #28 跟踪，受 Apple Developer Program 凭据阻塞；接入时只改 `electron-builder.yml`。
- README 已如实说明 quarantine 行为：在 issue #28 落地前，下载的制品仍会显示无法验证开发者的大门。
