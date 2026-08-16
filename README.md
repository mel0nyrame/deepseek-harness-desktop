# DSH Desktop

English | [中文](README.zh.md)

<p align="center">
  <img src="./assets/readme/hero-light.svg" width="100%" alt="DSH Desktop bundles the complete DeepSeek Harness runtime inside a native Electron application">
</p>

`deepseek-harness-desktop` packages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as the native Electron application **DSH Desktop**. The desktop shell is the product-specific layer; the bundled `dsh` runtime keeps its plugin system, sessions, tools, PTYs, persistence, CLI identity, and documentation vocabulary.

<p align="center">
  <img src="./assets/readme/product-window.png" width="100%" alt="Real installed DSH Desktop window with a native-selected workspace and the assembled agent composer">
</p>

<p align="center"><sub>Real renderer capture from the installed macOS bundle's packaged native-action acceptance journey.</sub></p>

## Desktop shell, full harness

<table>
  <tbody>
    <tr>
      <td align="center" width="50%"><img src="./assets/readme/icons/bundled-runtime.png" width="112" alt="Bundled runtime illustration"><br><strong>Bundled runtime</strong><br>The installed app starts its own application-scoped DSH child. A system Node.js or separately installed DSH CLI is not required.</td>
      <td align="center" width="50%"><img src="./assets/readme/icons/private-carrier.png" width="112" alt="Private carrier illustration"><br><strong>Private desktop carrier</strong><br>The sandboxed renderer crosses a context-isolated preload bridge and validated IPC. The desktop profile opens no browser-facing HTTP listener.</td>
    </tr>
    <tr>
      <td align="center" width="50%"><img src="./assets/readme/icons/native-workspace.png" width="112" alt="Native workspace illustration"><br><strong>Native workspace actions</strong><br>Electron main owns directory selection, path opening, macOS window integration, recovery, and process-tree cleanup.</td>
      <td align="center" width="50%"><img src="./assets/readme/icons/shared-state.png" width="112" alt="Shared state illustration"><br><strong>Shared DSH state</strong><br>DSH Desktop and the CLI use the same <code>~/.dsh</code> home, so sessions, profiles, and configuration remain available to both.</td>
    </tr>
  </tbody>
</table>

## How it works

The React client retains the transport-neutral Connection surface used by the Web product. Electron main owns the native window and supervises one dedicated DSH child; that child owns Cordis, sessions, plugins, model execution, PTYs, persistence, and subprocesses.

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="React renderer to preload bridge to Electron main to bundled DSH child architecture">
</p>

The [desktop application reference](apps/desktop/README.md) owns the complete carrier, lifecycle, packaging, native-action, recovery, and installed-app acceptance contracts.

<a id="run"></a><a id="run-from-source"></a>

## Start from source

The project is in developer preview. From this repository checkout:

```sh
pnpm install
pnpm run build
pnpm run dev:desktop
```

### Build macOS artifacts

```sh
pnpm --filter @deepseek-ai/dsh-desktop run package
```

The package command writes the host-architecture `.app` and `.dmg` under `apps/desktop/dist/`. Current local artifacts are ad-hoc signed and not notarized, so a downloaded build may require the one-time macOS right-click → Open flow.

## Project boundaries

- [DSH Desktop application reference](apps/desktop/README.md) — Electron architecture, security, lifecycle, packaging, acceptance, and limitations.
- [DeepSeek Harness architecture](docs/architecture.md) — the bundled plugin runtime and its extension model.
- [DeepSeek Harness user documentation](docs/user/index.md) — core DSH concepts and supported workflows.
- [Archived upstream README: English](archive/deepseek-harness-readme.md) · [中文](archive/deepseek-harness-readme.zh.md) — the original project overview and onboarding material retained when the desktop homepage replaced the root entry.
- [Upstream repository](https://github.com/deepseek-ai/deepseek-harness) — the original DeepSeek Harness project this desktop repository is based on.

## Status and distribution

- The repository and application are under active development; compatibility-breaking changes remain possible.
- The checked-in packaging path currently targets macOS and builds the host architecture.
- Developer ID signing and notarization are not configured; read the [desktop limitations](apps/desktop/README.md#limitations) before distributing artifacts.

## Development

Core contributor workflows remain in [CONTRIBUTING.md](CONTRIBUTING.md), the [development guide](docs/development.md), and [AGENTS.md](AGENTS.md). Changes to the bundled harness continue to follow those upstream-derived contracts; desktop-specific implementation lives under [`apps/desktop`](apps/desktop) and its supporting desktop plugins.

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
