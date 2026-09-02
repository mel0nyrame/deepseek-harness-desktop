# Agent Note: 稳定证据帧捕获

Status: implemented

[English](2026-09-02-stable-evidence-frame-capture.md) | 中文

## 问题

安装态应用的证据旅程通过 `capturePage()` 截图，用以证明桌面 UI 真实渲染完成。在打包门禁的 macOS runner 上，窗口合成器是软件渲染，`window.show()` 之后的最初几次合成可能返回低于 20 KB 绘制帧阈值的空白图像。此前的每个截图点都不做重试：一帧空白就会中止整条证据旅程，安装态应用以退出码 1 结束，打包门禁由此报告一个在真实渲染桌面上并不存在的产品缺陷。同样的单次截图模式散布在三处（官方 Client UI 旅程、原生窗口帧、terminal tracer 的完成帧），只修一处会让门禁经由其余两处继续抖动。

## 决策

所有桌面截图证据统一走共享捕获 `captureStableFrame(window, scope, name)`（位于 `apps/desktop/src/frame-capture.ts`）。每次尝试先结算两个渲染器动画帧，再捕获页面，且仅当 PNG 达到绘制帧阈值（默认 20 000 字节，可覆盖）时才接受；未绘制帧短延迟后重试，直到 15 秒预算耗尽，再以与之前相同的旅程作用域错误消息 fail-loud（`desktop UI|native|terminal evidence frame … is unexpectedly empty`），真正的空白渲染仍然会让门禁失败。官方 Client UI 旅程、原生窗口帧、terminal tracer 的完成帧都调用该 helper；tracer 的中间帧保持无阈值截图，因为没有断言依赖它们。外壳同时设置 Chromium 开关 `disable-backgrounding-occluded-windows`，被遮挡的窗口在旅程中途不再暂停合成。

## 验证

`tests/desktop-frame-capture.test.ts` 通过结构化假件注入未绘制帧序列：首帧即绘制则不重试直接接受；未绘制序列重试直到出现绘制帧；始终未绘制的捕获在预算耗尽后以旅程作用域消息 fail-loud；自定义最小尺寸同样生效。`pnpm run check` 与安装态门禁（`DSH_DESKTOP_PACKAGE_REQUIRED=1 pnpm run test:package`）经由真实 Electron 旅程覆盖该 helper。

## 已考虑的替代方案

**降低绘制帧阈值。** 接受极小图像会让真正空白的帧混入证据集，把真实渲染缺陷藏在绿色通过之后。

**截图前等更久或增加更多动画帧。** 基于时间的等待没有反馈信号；慢 CI 机器仍可能超出任何固定等待，而快本地运行白白付出延迟。

**离屏捕获。** 离屏渲染走的是与交付产品不同的合成器路径，门禁将不再证明用户所见，而且为了测试需要改变产品运行时行为。

**只修 CI 上失败的那条旅程。** 原生窗口与 terminal tracer 旅程会保留同一缺陷，之后再次抖动门禁；共享 helper 一次性移除该模式。

## 后果

证据旅程在软件渲染的 runner 上保住了已绘制帧的保证，而真正空白的渲染器仍会大声地使门禁失败；代价是所有截图位点现在共享同一个阈值与重试预算，调整捕获行为因此成为单一接缝上的改动。
