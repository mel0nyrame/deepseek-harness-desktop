# DSH Desktop

[English](README.md) | 中文

<p align="center">
  <img src="./assets/readme/hero-light.svg" width="100%" alt="DSH Desktop 将完整 DeepSeek Harness 运行时内置于原生 Electron 应用">
</p>

`deepseek-harness-desktop` 将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打包为原生 Electron 应用 **DSH Desktop**。桌面外壳是本项目专属的产品层；内置 `dsh` 运行时继续保留插件系统、Session、工具、PTY、持久化、CLI 身份与文档术语。

<p align="center">
  <img src="./assets/readme/product-window.png" width="100%" alt="安装态 DSH Desktop 窗口，显示原生 macOS 窗口框架、玻璃侧栏、带预制会话的隔离 Workspace 与装配完成的 agent 输入框">
</p>

<p align="center"><sub>使用隔离临时配置与预制会话，从已安装 macOS 应用包捕获的原生窗口，并以中性背景呈现。</sub></p>

## 原生 macOS 体验

<table>
  <tbody>
    <tr>
      <td align="center" width="18%"><img src="./assets/readme/icons/compact-native-window.svg" width="96" alt="紧凑原生窗口插画"></td>
      <td><strong>紧凑原生框架</strong><br>内容铺满窗口，控件与红绿灯区域自然衔接，并保留原生拖动与全屏行为。</td>
    </tr>
    <tr>
      <td align="center" width="18%"><img src="./assets/readme/icons/persistent-glass-sidebar.svg" width="96" alt="持久化玻璃侧栏插画"></td>
      <td><strong>会记住偏好的玻璃侧栏</strong><br>浅色、深色与跟随系统外观匹配 macOS；玻璃偏好可以持久化，并兼容“减少透明度”的不透明回退。</td>
    </tr>
    <tr>
      <td align="center" width="18%"><img src="./assets/readme/icons/zero-width-focus.svg" width="96" alt="零宽侧栏插画"></td>
      <td><strong>零宽专注模式</strong><br>完全收起侧栏，让会话占满窗口宽度；再次展开时恢复上次可用的侧栏宽度。</td>
    </tr>
  </tbody>
</table>

## 桌面外壳，完整 harness

<table>
  <tbody>
    <tr>
      <td align="center" width="50%"><img src="./assets/readme/icons/bundled-runtime.png" width="112" alt="内置运行时插画"><br><strong>内置运行时</strong><br>安装后的应用会启动自己的应用级 DSH 子进程，不要求系统提供 Node.js，也不要求另行安装 DSH CLI。</td>
      <td align="center" width="50%"><img src="./assets/readme/icons/private-carrier.png" width="112" alt="私有载体插画"><br><strong>私有桌面载体</strong><br>沙箱化 renderer 通过上下文隔离的 preload 桥和经过校验的 IPC 访问 DSH；desktop profile 不会打开面向浏览器的 HTTP 监听。</td>
    </tr>
    <tr>
      <td align="center" width="50%"><img src="./assets/readme/icons/native-workspace.png" width="112" alt="原生 Workspace 插画"><br><strong>原生 macOS 外壳</strong><br>Electron main 持有目录选择、路径打开、紧凑窗口框架与原生拖动、恢复和进程树清理；侧栏使用已保存的玻璃侧栏偏好。</td>
      <td align="center" width="50%"><img src="./assets/readme/icons/shared-state.png" width="112" alt="共享状态插画"><br><strong>共享 DSH 状态</strong><br>DSH Desktop 与 CLI 使用同一个 <code>~/.dsh</code> 主目录，因此两者都能访问 Session、profile 与配置。</td>
    </tr>
  </tbody>
</table>

## 工作原理

React 客户端继续使用与 Web 产品相同、与传输无关的 Connection 接口。Electron main 持有原生窗口并监管一个专用 DSH 子进程；该子进程持有 Cordis、Session、插件、模型执行、PTY、持久化与子进程。

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="React renderer 经 preload 桥和 Electron main 连接到内置 DSH 子进程的架构">
</p>

解耦前的载体、生命周期、打包、原生操作、恢复与安装态验收约定保留在冻结的[旧版桌面参考](legacy/apps/desktop/README.md)中；解耦后的外壳与桌面 Provider 约定随各自的切片落地（[`apps/desktop`](apps/desktop)、[`packages/`](packages)）。

<a id="run"></a><a id="run-from-source"></a>

## 安装

### Homebrew（推荐）

```sh
brew tap mel0nyrame/dsh
brew install --cask dsh-desktop
```

Cask 会为当前 Mac 选择 arm64 或 x64 构建，并在安装后移除隔离属性。稳定版发布后会自动更新 Cask；预发布版仅在 GitHub 提供。

### GitHub Releases

从 [GitHub Releases](https://github.com/mel0nyrame/deepseek-harness-desktop/releases) 下载适合当前 Mac 的 DMG（Apple 芯片选择 `arm64`，Intel 选择 `x64`），使用相邻的 `.sha256` 文件校验后，将 DSH Desktop 拖入“应用程序”。

发行 DMG 使用 ad-hoc 签名且未经公证。因此，直接下载 DMG 后可能需要在 macOS 上执行一次右键 → 打开；通过 Homebrew 安装时，Cask 会完成相应的隔离属性处理。

## 从源码启动

在当前仓库 checkout 中运行：

```sh
pnpm install
pnpm run check
```

`dev:desktop` 与打包命令会随解耦后的运行时与外壳切片回归；在此之前，冻结的旧版产品保留在 `legacy` 分支上。

## 项目边界

- [DSH Desktop 外壳](apps/desktop/README.md) — Electron 外壳角色及其边界。
- [桌面产品包](packages/AGENTS.md) — `@dsh-desktop/*` 的归属与依赖方向规则。
- [冻结的官方 monorepo 源码](legacy/README.md) — 解耦前的产品与官方内核，保留用于对比与恢复。
- [冻结的旧版桌面参考](legacy/apps/desktop/README.md) — 解耦前发布的 Electron 架构、安全、生命周期、打包、验收与限制。
- [固定的上游源码](upstream/README.md) — `dsh-v0.1.0-rc.8` 处锁定的官方 DeepSeek Harness 源码，仅用于源码检视与兼容性工作。
- [上游仓库](https://github.com/deepseek-ai/deepseek-harness) — 本桌面仓库直接基于的原始 DeepSeek Harness 项目。

## 状态与分发

- 仓库与应用仍在积极开发中，未来仍可能出现破坏兼容性的变更。
- 产品发行版分别提供 arm64 与 x64 macOS DMG，并附带 SHA-256 校验文件。
- 尚未配置 Developer ID 签名与公证；直接下载时可能需要执行上文所述的一次性右键 → 打开。再次分发产物前请阅读[旧版桌面限制](legacy/apps/desktop/README.md#limitations)。

## 开发

内核贡献流程以 [AGENTS.md](AGENTS.md) 为准；冻结的[开发指南](legacy/docs/development.md)与 [CONTRIBUTING.md](legacy/CONTRIBUTING.md) 记录了解耦前的贡献流程。桌面端专属实现位于 [`apps/desktop`](apps/desktop) 与桌面 Provider 包（[`packages/`](packages)）中。

## 许可证

[MIT](LICENSE)

解耦前产品的第三方依赖及其许可证见冻结的 [THIRD_PARTY_NOTICES.md](legacy/THIRD_PARTY_NOTICES.md)；解耦后产品的声明清单随打包切片落地。
