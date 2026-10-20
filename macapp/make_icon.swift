// Draws the 1024px VidAnki app icon: flat dark square, blue play mark, one
// card behind it (video then Anki). Usage: swift make_icon.swift out.png
import AppKit

let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
NSColor(calibratedRed: 0.07, green: 0.075, blue: 0.085, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: size, height: size).fill()

// card behind
NSColor(calibratedRed: 0.17, green: 0.19, blue: 0.22, alpha: 1).setFill()
NSRect(x: 300, y: 250, width: 500, height: 560).fill()
NSColor(calibratedRed: 0.37, green: 0.77, blue: 0.54, alpha: 1).setFill()
NSRect(x: 300, y: 250, width: 500, height: 26).fill()

// play mark
let play = NSBezierPath()
play.move(to: NSPoint(x: 250, y: 300))
play.line(to: NSPoint(x: 250, y: 724))
play.line(to: NSPoint(x: 620, y: 512))
play.close()
NSColor(calibratedRed: 0.43, green: 0.66, blue: 1.0, alpha: 1).setFill()
play.fill()
img.unlockFocus()

let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
