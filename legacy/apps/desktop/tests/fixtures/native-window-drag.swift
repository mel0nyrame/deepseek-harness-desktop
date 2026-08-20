import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 5,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]),
      let dx = Double(CommandLine.arguments[3]),
      let dy = Double(CommandLine.arguments[4]) else {
  fputs("usage: native-window-drag.swift <x> <y> <dx> <dy>\n", stderr)
  exit(2)
}

let source = CGEventSource(stateID: .combinedSessionState)
let start = CGPoint(x: x, y: y)
let end = CGPoint(x: x + dx, y: y + dy)

guard let down = CGEvent(
  mouseEventSource: source,
  mouseType: .leftMouseDown,
  mouseCursorPosition: start,
  mouseButton: .left
) else {
  fputs("failed to create mouse-down event\n", stderr)
  exit(1)
}
down.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.12)

for step in 1...8 {
  let fraction = CGFloat(step) / 8
  let point = CGPoint(
    x: start.x + (end.x - start.x) * fraction,
    y: start.y + (end.y - start.y) * fraction
  )
  guard let dragged = CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseDragged,
    mouseCursorPosition: point,
    mouseButton: .left
  ) else {
    fputs("failed to create mouse-dragged event\n", stderr)
    exit(1)
  }
  dragged.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.03)
}

guard let up = CGEvent(
  mouseEventSource: source,
  mouseType: .leftMouseUp,
  mouseCursorPosition: end,
  mouseButton: .left
) else {
  fputs("failed to create mouse-up event\n", stderr)
  exit(1)
}
up.post(tap: .cghidEventTap)
