# Agent Note: 打包门禁的文件描述符余量

Status: implemented

[English](2026-09-02-packaging-gate-fd-headroom.md) | 中文

## 问题

内嵌 runtime 闭包含约三万个文件，electron-builder 在打包时对其中每一个执行 seal 和签名。签名并发峰值超过打包门禁 macOS runner 的默认文件描述符 soft 上限，门禁因此在签名中途死于 `EMFILE: too many open files` —— 并且是非确定性的，因为峰值随时序与垃圾回收漂移。同一棵树在更早的 run 上打包成功（GitHub Actions run 33577883843 失败；相同内容的 run 成功），这说明门禁不可靠，而不是产品坏了。

## 决策

门禁提高文件描述符上限，而不是缩减 runtime。CI 打包步骤在运行打包脚本前把 soft 上限提高到 65 536，若该值不被允许则回退到宿主机自身的 hard 上限。作为第二层，`scripts/package-desktop.ts` 包装了 electron-builder 构建：错误报告为 `EMFILE` 的失败会触发恰好一次干净重试（先删除并重建输出目录），因为同样的限制下一次新尝试通常能完成，时序漂移随之复位。所有其他失败立即抛出。打包脚本本身不经 shell 重新调用，打包内容保持不变。

## 验证

本地 `ulimit -n 256 && pnpm run package` 复现了签名阶段的 `EMFILE`，错误形态与 CI 失败一致（错误里随机点名一个 runtime 文件）；提高上限后打包成功。`tests/desktop-package.test.ts` 继续锁定 `package` 脚本命令与 dry-run 契约，因此修复保持在脚本调用面之外。

## 已考虑的替代方案

**禁用或替换 electron-builder 的 macOS 签名。** Apple Silicon 拒绝启动未签名的二进制，而门禁必须启动安装产物；ad-hoc 签名无法跳过。

**从 runtime 闭包剥离 source map。** 更少的文件降低峰值，但门禁仍与宿主机的 fd 上限耦合，并丢掉崩溃排查依赖的栈映射。

**给 electron-builder 打补丁。** 该依赖钉在精确的已发布版本上；维护 fork 会把一行资源配置换成永久的升级税。
