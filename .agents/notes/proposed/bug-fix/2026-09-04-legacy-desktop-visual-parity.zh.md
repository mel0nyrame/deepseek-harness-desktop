# Agent Note：恢复 legacy 桌面视觉一致性

Status: proposed

[English](2026-09-04-legacy-desktop-visual-parity.md) | 中文

规格：[#99](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/99)

## 问题

解耦后的桌面产品保留了已发布 Client 的功能图，但不再一致呈现获批的 macOS 窗口。替代 chrome 隐藏了已发布侧栏的 header，把完整品牌缩减为纯文本，以字符箭头替代 panel 图标，并将 traffic lights 行和品牌行压成一行。当前应用还会等 runtime 就绪后才创建窗口，因此 legacy 的 starting、recovering、failed 和 stopping 界面全部缺失。现有视觉证据测试要么接受合成标记，要么仅证明真实帧非空且彼此不同；它们不会把真实产品与获批呈现进行比较。

获批的工作区首页参考是 `assets/readme/source/screenshots/native-window-product.png`。对应 legacy 实现是辅助证据，并负责规定没有获批参考图的产品界面外观。实时 workspace、session、model、permission 和相对时间内容属于产品状态，不属于视觉契约。

## 提案

先审计 Electron 产品窗口承载的每个用户可见界面，再按以下顺序恢复 macOS 呈现：共享窗口与布局基础、启动状态界面、工作区首页，以及其余 conversation、details 和 settings 界面。获批参考图与 legacy 实现有差异时以参考图为准；否则以 legacy 实现和隔离运行的 legacy runtime 为比较来源。

恢复完整的可见启动生命周期，包括 starting、recovering、failed、stopping 状态，以及可用的 restart 和 quit 操作。恢复 `1280×840` 初始窗口，并保留 `900×640` 最小尺寸。在较窄宽度下保留 legacy 的响应式折叠行为。

按[桌面 transport 上的官方 Client 合成](../../implemented/architecture/2026-08-31-official-client-desktop-composition.zh.md)所述，继续让已发布 Client 作为产品界面。保留 legacy 中不存在的迁移后功能，并用 legacy 视觉语言呈现。macOS 专用 chrome、材质和 traffic-light 集成继续限制在平台范围内；其他平台保留当前呈现。系统拥有的 picker、menu 和 dialog 不参与视觉一致性比较，但继续覆盖其应用行为。

在稳定 slot 与已发布 primitive 能表达获批结构时使用它们。如果已发布包无法暴露所需结构，则使用带明确删除条件的最小精确版本补丁，而不是复制 Client 包。本提案纠正 [macOS 紧凑桌面窗口呈现](../../implemented/feature/2026-08-16-macos-compact-window-presentation.zh.md)中的呈现与证据缺口，但不替换其中的原生所有权或 teardown 决策。

## 审计与证据矩阵

| 界面或状态 | 获批证据 | 当前缺口 | 计划证据 |
|---|---|---|---|
| 启动状态：starting、recovering、failed、stopping | Legacy 状态界面与生命周期 | 产品窗口只在 runtime 就绪后创建 | 真实生命周期断言与稳定状态区域截图 |
| 工作区首页：浅色、展开、已选 workspace | 获批仓库图片与 legacy 实现 | 品牌、panel 控件、行结构、几何和初始尺寸不同 | 确定性真实产品参考截图，以及语义与几何断言 |
| 工作区首页：未选 workspace | Legacy 行为 | Model 与 permission 控件按状态显示是正确的，但 chrome 仍有差异 | 选择 workspace 前的真实产品流程 |
| 侧栏：展开、收起、窄窗口、全屏 | Legacy 布局与原生呈现 | 现有测试不检查获批品牌与控件位置 | 语义、响应式几何与聚焦区域断言 |
| 首次 onboarding | Legacy 的 Internal Testing 与 API key 对话框；当前已发布组件保留相同 welcome 内容 | 当前桌面证据流程会在渲染前确认 onboarding，真实窗口从未覆盖它 | 隔离首次运行 profile，依次通过两层对话框 |
| Composer menu 与 input trigger | Legacy 的 workspace、model、access、command 和 trigger 界面 | 核心 selector 仍等价；当前 menu 增加了不得移除的分组 | 在主窗口尺寸与最小窗口尺寸下验证真实定位弹层 |
| Conversation：streaming、complete 与 error | Legacy replay 流程与 header 避让规则 | 当前证据捕获这些状态，但不检查几何；legacy header hook 与避让规则已经缺失 | Keyless 真实 turn，以及 header、tab、content 和 error 区域断言 |
| Question、approval 与 plan takeover | Legacy pending 与 settled 证据；当前核心组件仍等价 | 当前没有桌面级视觉覆盖 | 真实 pending、minimized、长 command 与 settled 状态 |
| Details：关闭、打开与缩放 | Legacy 不透明 details 界面；当前核心 panel 仍等价 | 材质与窄宽度组合没有桌面视觉断言 | 在宽窄窗口的玻璃与不透明状态下打开真实 tool details |
| 外观与材质：浅色、深色、玻璃、不透明 | Legacy 原生呈现 | 现有帧只证明各变体不同 | Body 状态、计算样式与聚焦区域断言 |
| Settings：General、Models 与 Plugins | Legacy dialog 与集成在 Appearance 中的 switch | 当前桌面玻璃偏好是独立原生 checkbox 行，而不是 legacy switch | 真实 dialog 导航、设置持久化与聚焦截图 |
| 焦点、拖动、最小化、恢复与缩放 | Legacy 原生窗口证据；当前 traffic-light 坐标和窗口选项仍等价 | 周围 DOM chrome 与 inactive 材质不同 | 现有 OS 行为断言，加产品拥有区域截图 |
| 当前独有功能与失败 panel | 没有 legacy 对应实现 | File-open failure、结构化引用、附件和新版 menu 组织没有 legacy 基准 | 保留行为，并按共享 legacy 视觉语言评审呈现 |

## 确定性参考状态

通过真实 Host API 和 Client 流程创建固定 workspace 与三条非空 session。用 keyless replay 驱动每条 session，再通过真实 rename API 分配获批图片中的可见标题。固定 locale、appearance、窗口尺寸、workspace 名称、session 顺序和标题。冻结相对时间，或将其排除在图片比较之外。合成 React 标记可以继续充当聚焦 fixture，但不能宣称验证产品视觉一致性。

Issue #100 在源码与已安装产品旅程中建立了这条参考接缝。隔离 tracer profile 提供三份参考 replay 脚本、一份补充 terminal 行为脚本，以及固定 locale 和 appearance 偏好，不会触及普通 profile。该旅程在 `evidence.json` 中记录参考 session 标识、非空状态、replay marker、稳定顺序、animation 与 compositor settlement、语义事实、解析后几何和图片哈希。在呈现修复落地前，契约还记录品牌身份、panel 图标、chrome 行结构与初始窗口尺寸这四项已知 mismatch。补充脚本在不改变三 session 参考截图的前提下，保留已安装产品的 streaming、tool、completion 与 replay-exhaustion gate。合成 Electron fixture 仅归类为 contribution composition 冒烟测试。

获批图片继续作为人工视觉契约。只有 reviewer 确认真实产品渲染与该图片及适用 legacy 界面一致后，自动化才记录新的确定性基准。基准更新必须明确且可审查。浅色、已选 workspace、展开侧栏的主状态进行图片比较；启动、未选 workspace、收起、深色、不透明、全屏、conversation、details 和 settings 状态采用语义与几何断言，并在稳定位置增加聚焦截图。

## 考虑过的替代方案

**恢复复制的 legacy Client 包。** 否决：这会重新制造桌面合成工作已经移除的 frontend fork 与耦合。

**只修补当前 chrome CSS。** 否决：这不会恢复缺失的启动生命周期，会让全产品审计保持不完整，也会保留脆弱的位置选择器。

**把现有合成证据页当作视觉权威。** 否决：它没有渲染已发布产品图、真实图标或真实状态转换。

**让每个完整帧直接与旧 PNG 比较。** 否决：实时内容、相对时间、操作系统文本渲染和原生 traffic lights 都不是稳定图片输入。分层的语义、几何和获批区域证据可以隔离产品拥有的契约。

## 验收标准

- 修复开始前，Electron 承载的每个产品界面都对照其获批图片或 legacy 实现完成盘点。
- macOS 应用公开完整的启动状态生命周期，初始打开为 `1280×840`，并保留 `900×640` 最小尺寸。
- 真实工作区首页匹配获批品牌、图标、结构、尺寸、间距、字体、颜色和材质，同时保留依赖状态的控件与实时数据。
- Conversation、details、settings、响应式、全屏、外观、透明度、焦点和失败状态保留行为，并匹配适用的 legacy 呈现。
- 新产品能力继续可用并完成视觉整合。非 macOS 呈现和系统拥有的 UI 不进行重绘。
- 确定性的真实产品参考流程通过支持的 API 和 keyless 模型 replay 创建数据。该流程在修复前因已观察到的视觉差异失败，并在修复后通过。
- 已发布 Client 继续作为唯一产品 frontend。任何精确版本补丁都保持最小，在 runtime manifest 中记录，由聚焦测试覆盖，并带有删除条件。

## 风险

全产品审计可能膨胀为无关的官方 Client 重新设计。获批图片、legacy 证据、平台边界和有序矩阵会约束该范围。图片断言若包含原生 glyph、相对时间、动画或 compositor 转换，可能变得不稳定；确定性状态与区域比较必须排除这些输入。恢复状态窗口也会改变生命周期可见行为，因此 failure、restart、quit、cancellation 和 teardown 需要行为覆盖，而不能只靠截图证明。
