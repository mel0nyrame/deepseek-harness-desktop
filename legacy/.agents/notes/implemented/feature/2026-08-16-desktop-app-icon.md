# Agent Note: DSH Desktop ships the official fish logo on a light tile as its app icon

Status: implemented

English | [中文](2026-08-16-desktop-app-icon.zh.md)

## Problem

The desktop bundle had no application icon: `electron-builder.yml` declared no `mac.icon`, so every produced `DSH Desktop.app` shipped the default Electron icon (`CFBundleIconFile` → `electron.icns`). The issue #9 release artifacts therefore carried no product identity in the Dock, Finder, or dmg. The official DeepSeek Harness mark is the fish logo (`packages/client/ui-primitives/src/FishLogo.tsx`, the same geometry as the web favicon). macOS icns files are static — the favicon's dark-mode black→white flip cannot be replicated in the Dock — so a pure black-on-transparent icon would disappear against dark wallpapers and the dark Dock.

## Decision

Ship the official fish on a light rounded tile, chosen by the maintainer among three candidate treatments:

- **Official geometry** — `build/icon.svg` embeds the exact FishLogo path (viewBox `0 0 23.16 17.04`) scaled to a 720×528 black-pixel bound on a 1024×1024 light rounded tile (white→#F1F4F8 gradient, 230px corner radius). The 120% mark scale improves Dock and Finder recognition while retaining a 152px safe margin at the narrowest edge.
- **Deterministic rasterization** — `scripts/icon.ts` renders `build/icon.png` (1024×1024) with sharp, an apps/desktop devDependency; both the SVG source and the PNG are committed, so CI consumes the PNG and never rasterizes.
- **Builder wiring** — `electron-builder.yml` sets `mac.icon: build/icon.png`; electron-builder converts the PNG into `Contents/Resources/icon.icns` and points `CFBundleIconFile` at it.
- **Evidence gate** — `hasCustomBundleIcon` in `scripts/artifact-evidence.ts`: a produced bundle must contain `Contents/Resources/icon.icns` AND the exact `<string>icon.icns</string>` plist reference (the full-tag match keeps `electron.icns` from passing as a substring). The packaging pipeline fails the build when the default icon ships. Unit-tested in `apps/desktop/tests/package.spec.ts`.

## Alternatives considered

- **Pure black fish on transparent** — the exact official favicon look, but macOS has no dark-mode icon variant and the icon would vanish in the dark Dock. Rejected.
- **Brand-blue tile with a white fish** — the #4D6BFE badge blue; the most visible option, but the farthest from the official black icon. Rejected.
- **Rasterize at package time with qlmanage/sips** — qlmanage rendering varies across macOS versions; committing the sharp-rendered PNG keeps the pipeline deterministic and reviewable. Rejected.

## Consequences

- `pnpm --filter @deepseek-ai/dsh-desktop run icon` regenerates the PNG; the packaging pipeline refuses bundles that ship the default Electron icon.
- The development instance (`pnpm run dev:desktop`) still shows the Electron default Dock icon: bundle icons apply only to the packaged application.
- sharp joins `apps/desktop` devDependencies; it was already resolved in the workspace through `@deepseek-ai/dsh-attachment-local`, so no new resolution surface appears.
