# Agent Note: Restore legacy desktop visual parity

Status: proposed

English | [中文](2026-09-04-legacy-desktop-visual-parity.zh.md)

Specification: [#99](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/99)

## Problem

The decoupled desktop product preserves the published Client feature graph but no longer presents the approved macOS window consistently. Its replacement chrome hides the published sidebar header, reduces the full brand to plain text, substitutes character arrows for the panel icon, and compresses the traffic-light and brand rows into one. The current application also waits for the runtime before creating its window, so the legacy starting, recovering, failed, and stopping surfaces are absent. Existing visual evidence tests accept synthetic markup or merely prove that real frames are non-empty and distinct; they do not compare the real product with the approved presentation.

The approved workspace-home reference is `assets/readme/source/screenshots/native-window-product.png`. The corresponding legacy implementation remains supporting evidence, and owns the expected appearance for product surfaces that have no approved reference image. Live workspace, session, model, permission, and relative-time content is product state rather than part of the visual contract.

## Proposal

Audit every user-visible surface hosted by the Electron product window, then restore the macOS presentation in this order: shared window and layout foundations, boot status surfaces, workspace home, and the remaining conversation, details, and settings surfaces. The approved reference image wins when it and the legacy implementation differ; otherwise the legacy implementation and isolated legacy runtime are the comparison source.

Restore the complete visible boot lifecycle, including starting, recovering, failed, and stopping states and the available restart and quit actions. Restore a `1280×840` initial window with a `900×640` minimum. At narrower widths, retain the legacy responsive collapse behavior.

Keep the published Client as the product surface described by [Official Client composition over the desktop transport](../../implemented/architecture/2026-08-31-official-client-desktop-composition.md). Preserve migrated features that have no legacy counterpart and present them in the legacy visual language. macOS-specific chrome, material, and traffic-light integration remain platform-scoped; other platforms retain their current presentation. System-owned pickers, menus, and dialogs are outside visual-parity comparison, though their application behavior remains covered.

Use stable slots and published primitives where they express the approved structure. If a published package cannot expose the required structure, use the smallest exact-version patch with an explicit removal condition rather than copying a Client package. This proposal corrects the presentation and evidence gaps in [macOS compact desktop-window presentation](../../implemented/feature/2026-08-16-macos-compact-window-presentation.md) without replacing its native ownership or teardown decisions.

## Audit and evidence matrix

| Surface or state | Approved evidence | Current gap | Planned evidence |
|---|---|---|---|
| Boot status: starting, recovering, failed, stopping | Legacy status surface and lifecycle | The product window is created only after runtime readiness | Real lifecycle assertions and stable state-region captures |
| Workspace home: light, expanded, selected workspace | Approved repository image plus legacy implementation | Brand, panel control, row structure, geometry, and initial dimensions differ | Deterministic real-product reference capture plus semantic and geometry assertions |
| Workspace home: no workspace selected | Legacy behavior | Model and permission controls are correctly state-dependent but chrome still differs | Real product journey before workspace selection |
| Sidebar: expanded, collapsed, narrow, full screen | Legacy layout and native presentation | Existing tests do not assert approved brand and control placement | Semantic, responsive geometry, and focused region assertions |
| First-run onboarding | Legacy Internal Testing and API-key dialogs; current published components retain the same welcome content | The current desktop evidence journey acknowledges onboarding before rendering and never covers it in the real window | Isolated first-run profile through both dialogs |
| Composer menus and input triggers | Legacy workspace, model, access, command, and trigger surfaces | Core selectors remain equivalent; current menus add grouping that must not be removed | Real positioned popups at the primary and minimum window sizes |
| Conversation: streaming, complete, and error | Legacy replay journey and header-clearance rules | Current evidence captures the states but does not assert their geometry; the legacy header hooks and clearance rules are absent | Keyless real turns plus header, tabs, content, and error-region assertions |
| Question, approval, and plan takeover | Legacy pending and settled evidence; core current components remain equivalent | No current desktop-level visual coverage | Real pending, minimized, long-command, and settled states |
| Details: closed, open, and resized | Legacy opaque details surface; the current core panel remains equivalent | Material and narrow-width composition have no desktop visual assertion | Real tool details over glass and opaque states at wide and narrow widths |
| Appearance and material: light, dark, glass, opaque | Legacy native presentation | Existing frames prove only that variants differ | Body-state, computed-style, and focused region assertions |
| Settings: General, Models, and Plugins | Legacy dialog and integrated Appearance switch | The current desktop glass preference is a separate native-checkbox row rather than the legacy switch | Real dialog navigation and settings persistence with focused captures |
| Focus, drag, minimize, restore, and resize | Legacy native-window evidence; current traffic-light coordinates and window options remain equivalent | Surrounding DOM chrome and inactive material differ | Existing OS behavior assertions plus product-owned region captures |
| Current-only features and failure panels | No legacy counterpart | File-open failure, structured references, attachments, and newer menu organization have no legacy baseline | Preserve behavior and judge their presentation against the shared legacy visual language |

## Deterministic reference state

Create a fixed workspace and three non-blank sessions through the real Host API and Client flow. Drive each session with keyless replay, then assign the visible titles from the approved image through the real rename API. Fix locale, appearance, window size, workspace name, session ordering, and titles. Freeze relative time or exclude it from image comparison. Synthetic React markup may remain useful as a focused fixture, but it cannot claim product visual parity.

The approved image remains the human visual contract. Automation records a new deterministic baseline only after a reviewer confirms that the real product rendering agrees with that image and the applicable legacy surfaces. Baseline updates must be explicit and reviewable. The primary light, selected-workspace, expanded-sidebar state receives image comparison; boot, unselected-workspace, collapsed, dark, opaque, full-screen, conversation, details, and settings states receive semantic and geometry assertions plus focused captures where stable.

## Alternatives considered

**Restore the copied legacy Client packages.** Rejected because it would recreate the frontend fork and coupling removed by the desktop composition work.

**Patch only the current chrome CSS.** Rejected because it would not restore the missing boot lifecycle, would leave the whole-product audit incomplete, and would preserve brittle positional selectors.

**Treat the existing synthetic evidence page as the visual authority.** Rejected because it does not render the published product graph, real icons, or real state transitions.

**Compare every full frame directly with the old PNG.** Rejected because live content, relative time, operating-system text rendering, and native traffic lights are not stable image inputs. Layered semantic, geometry, and approved region evidence isolates the product-owned contract.

## Acceptance criteria

- Every Electron-hosted product surface is inventoried against its approved image or legacy implementation before repair begins.
- The macOS application exposes the complete boot-status lifecycle and opens initially at `1280×840`, with `900×640` retained as its minimum.
- The real workspace home matches the approved brand, iconography, structure, dimensions, spacing, typography, colors, and materials while preserving state-dependent controls and live data.
- Conversation, details, settings, responsive, full-screen, appearance, transparency, focus, and failure states retain their behavior and match the applicable legacy presentation.
- Newer product capabilities remain available and visually integrated. Non-macOS presentation and system-owned UI are not restyled.
- A deterministic real-product reference journey creates its data through supported APIs and keyless model replay. It fails before the repair for the observed visual differences and passes afterward.
- The published Client remains the sole product frontend. Any exact-version patch is minimal, recorded in the runtime manifest, covered by focused tests, and carries a deletion condition.

## Risks

A whole-product audit can expand into unrelated official Client redesign. The approved image, legacy evidence, platform boundary, and ordered matrix constrain that scope. Image assertions can become flaky if they include native glyphs, relative time, animation, or compositor transitions; deterministic state and region-level comparisons must exclude those inputs. Restoring the status window also changes lifecycle-visible behavior, so failure, restart, quit, cancellation, and teardown need behavioral coverage rather than screenshot-only proof.
