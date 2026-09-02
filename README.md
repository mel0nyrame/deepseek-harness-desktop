# DSH Desktop

English | [中文](README.zh.md)

<p align="center">
  <img src="./assets/readme/hero-light.svg" width="100%" alt="DSH Desktop bundles the complete DeepSeek Harness runtime inside a native Electron application">
</p>

`deepseek-harness-desktop` packages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as the native Electron application **DSH Desktop**. The desktop shell is the product-specific layer; the bundled `dsh` runtime keeps its plugin system, sessions, tools, PTYs, persistence, CLI identity, and documentation vocabulary.

<p align="center">
  <img src="./assets/readme/product-window.png" width="100%" alt="Installed DSH Desktop window with native macOS chrome, a glass sidebar, an isolated workspace with preset sessions, and the assembled agent composer">
</p>

<p align="center"><sub>Native window capture from the installed macOS bundle using an isolated temporary profile and preset sessions, framed against a neutral backing.</sub></p>

## Native macOS experience

<table>
  <tbody>
    <tr>
      <td align="center" width="18%"><img src="./assets/readme/icons/compact-native-window.svg" width="96" alt="Compact native window illustration"></td>
      <td><strong>Compact native frame</strong><br>Content fills the window while controls share the traffic-light region, with native dragging and full-screen behavior.</td>
    </tr>
    <tr>
      <td align="center" width="18%"><img src="./assets/readme/icons/persistent-glass-sidebar.svg" width="96" alt="Persistent glass sidebar illustration"></td>
      <td><strong>Glass that remembers</strong><br>Light, Dark, and System appearances follow macOS; the glass preference persists, with an opaque Reduce Transparency fallback.</td>
    </tr>
    <tr>
      <td align="center" width="18%"><img src="./assets/readme/icons/zero-width-focus.svg" width="96" alt="Zero-width sidebar illustration"></td>
      <td><strong>Zero-width focus mode</strong><br>Collapse the sidebar completely to reclaim the conversation width, then restore the last usable sidebar size.</td>
    </tr>
  </tbody>
</table>

## Desktop shell, full harness

<table>
  <tbody>
    <tr>
      <td align="center" width="50%"><img src="./assets/readme/icons/bundled-runtime.png" width="112" alt="Bundled runtime illustration"><br><strong>Bundled runtime</strong><br>The installed app starts its own application-scoped DSH child. A system Node.js or separately installed DSH CLI is not required.</td>
      <td align="center" width="50%"><img src="./assets/readme/icons/private-carrier.png" width="112" alt="Private carrier illustration"><br><strong>Private desktop carrier</strong><br>The sandboxed renderer crosses a context-isolated preload bridge and validated IPC. The desktop profile opens no browser-facing HTTP listener.</td>
    </tr>
    <tr>
      <td align="center" width="50%"><img src="./assets/readme/icons/native-workspace.png" width="112" alt="Native workspace illustration"><br><strong>Native macOS shell</strong><br>Electron main owns directory selection, path opening, compact window chrome and native dragging, recovery, and process-tree cleanup; the sidebar uses the saved glass preference.</td>
      <td align="center" width="50%"><img src="./assets/readme/icons/shared-state.png" width="112" alt="Shared state illustration"><br><strong>Shared DSH state</strong><br>DSH Desktop and the CLI use the same <code>~/.dsh</code> home, so sessions, profiles, and configuration remain available to both.</td>
    </tr>
  </tbody>
</table>

## How it works

The React client retains the transport-neutral Connection surface used by the Web product. Electron main owns the native window and supervises one dedicated DSH child; that child owns Cordis, sessions, plugins, model execution, PTYs, persistence, and subprocesses.

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="React renderer to preload bridge to Electron main to bundled DSH child architecture">
</p>

The pre-decoupling carrier and lifecycle contracts remain available in the frozen [legacy desktop reference](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/apps/desktop/README.md). The current shell and desktop provider contracts live in [`apps/desktop`](apps/desktop) and [`packages/`](packages).

<a id="run"></a><a id="run-from-source"></a>

## Install

### Homebrew (recommended)

```sh
brew tap mel0nyrame/dsh
brew install --cask dsh-desktop
```

The cask selects the arm64 or x64 build for the current Mac and removes the quarantine attribute after installation. Stable releases update the cask automatically; prereleases remain available from GitHub only.

### GitHub Releases

Download the DMG for your Mac (`arm64` for Apple silicon or `x64` for Intel) from [GitHub Releases](https://github.com/mel0nyrame/deepseek-harness-desktop/releases), verify it against the adjacent `.sha256` file, and drag DSH Desktop to Applications.

Release DMGs are ad-hoc signed and not notarized. A direct DMG download may therefore require the one-time macOS right-click → Open flow. The Homebrew cask performs the corresponding quarantine handling during installation.

## Run from source

From this repository checkout:

```sh
pnpm install
pnpm run check
```

Build an installable, ad-hoc signed application and DMG with `pnpm run package`.
The packaging command assembles the exact published runtime, verifies native
addons under Electron, validates the application identity and embedded runtime,
and writes products under `apps/desktop/dist/`. Run the installed-product gate
with `DSH_DESKTOP_PACKAGE_REQUIRED=1 pnpm run test:package`.

## Project boundaries

- [DSH Desktop shell](apps/desktop/README.md) — the Electron shell role and its boundary.
- [Desktop product packages](packages/AGENTS.md) — ownership and dependency rules for `@dsh-desktop/*`.
- [Frozen pre-decoupling monorepo](https://github.com/mel0nyrame/deepseek-harness-desktop/tree/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy) — historical comparison and recovery only.
- [Frozen legacy desktop reference](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/apps/desktop/README.md) — Electron architecture, security, lifecycle, packaging, acceptance, and limitations as shipped pre-decoupling.
- [Pinned upstream source](upstream/README.md) — the exact official DeepSeek Harness source at `dsh-v0.1.0-rc.8`, for inspection and compatibility work.
- [Upstream repository](https://github.com/deepseek-ai/deepseek-harness) — the original DeepSeek Harness project this desktop repository is based on.

## Status and distribution

- The repository and application are under active development; compatibility-breaking changes remain possible.
- Product releases provide separate arm64 and x64 macOS DMGs with SHA-256 checksum files.
- Developer ID signing and notarization are not configured; direct downloads may need the one-time right-click → Open flow described above. Read the [legacy desktop limitations](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/apps/desktop/README.md#limitations) before redistributing artifacts.

## Development

CI is staged by change risk: ordinary pull requests run the fast workspace checks (`.github/workflows/ci.yml`), packaging inputs run the macOS packaging gate (`.github/workflows/packaging.yml`), and pull requests labeled `release`, version tags, or manual dispatches run the arm64/x64 release-evidence workflow (`.github/workflows/release.yml`). The promotion evidence, the protected manual real-API acceptance command, and the promotion checklist for making this branch the default live in [`docs/promotion/promotion.md`](docs/promotion/promotion.md).

Core contributor workflows remain in [AGENTS.md](AGENTS.md); the frozen [development guide](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/docs/development.md) and [CONTRIBUTING.md](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/CONTRIBUTING.md) document the pre-decoupling contribution flow. Desktop-specific implementation lives under [`apps/desktop`](apps/desktop) and the desktop provider packages ([`packages/`](packages)).

## License

[MIT](LICENSE)

The pre-decoupling product's third-party notices remain available in the frozen [THIRD_PARTY_NOTICES.md](https://github.com/mel0nyrame/deepseek-harness-desktop/blob/0971b9f0e3e9293e3f76c45b1d72f5789244ccdf/legacy/THIRD_PARTY_NOTICES.md).
