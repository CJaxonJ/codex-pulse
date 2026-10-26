// Build-time only. AppKit preserves SVG transparency; Quick Look adds a white matte.
import AppKit

enum AssetError: Error { case invalid(String) }

func bitmap(_ image: NSImage, width: Int, height: Int) throws -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
        pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: rep)
    else { throw AssetError.invalid("Cannot create RGBA canvas") }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let rect = NSRect(x: 0, y: 0, width: width, height: height)
    NSColor.clear.setFill()
    rect.fill(using: .copy)
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    return rep
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    guard args.count >= 3, let image = NSImage(contentsOfFile: args[1])
    else { throw AssetError.invalid("Usage: render input output width height | verify-icon input size") }
    if args[0] == "render", args.count == 5,
        let width = Int(args[3]), let height = Int(args[4]), width > 0, height > 0 {
        let rep = try bitmap(image, width: width, height: height)
        guard let png = rep.representation(using: .png, properties: [:])
        else { throw AssetError.invalid("PNG encoding failed") }
        try png.write(to: URL(fileURLWithPath: args[2]), options: .atomic)
    } else if args[0] == "preview", args.count == 3 {
        let canvas = NSImage(size: NSSize(width: 800, height: 360), flipped: false) { rect in
            NSColor(calibratedWhite: 0.96, alpha: 1).setFill()
            rect.fill()
            NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
            NSRect(x: 400, y: 0, width: 400, height: 360).fill()
            for x in [CGFloat(0), CGFloat(400)] {
                image.draw(in: NSRect(x: x + 86, y: 100, width: 228, height: 228))
                image.draw(in: NSRect(x: x + 126, y: 40, width: 48, height: 48))
                image.draw(in: NSRect(x: x + 206, y: 48, width: 32, height: 32))
                image.draw(in: NSRect(x: x + 266, y: 56, width: 16, height: 16))
            }
            return true
        }
        let rep = try bitmap(canvas, width: 1600, height: 720)
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
    } else if args[0] == "verify-icon", args.count == 3,
        let size = Int(args[2]), size >= 16 {
        let rep = try bitmap(image, width: size, height: size)
        // Test the actual exported image, not merely the SVG's declared rx/alpha.
        // Edge centres also catch a rounded white tile accidentally filled to the canvas.
        for (x, y) in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1),
                       (0, size / 2), (size - 1, size / 2),
                       (size / 2, 0), (size / 2, size - 1)] {
            guard let color = rep.colorAt(x: x, y: y), color.alphaComponent < 0.01
            else { throw AssetError.invalid("Opaque outer edge in \(args[1]) at \(size)px (\(x),\(y))") }
        }
        guard let center = rep.colorAt(x: size / 2, y: size / 2), center.alphaComponent > 0.99
        else { throw AssetError.invalid("Missing opaque icon centre in \(args[1])") }
        print("Verified rounded alpha: \(args[1]) @ \(size)px")
    } else { throw AssetError.invalid("Invalid renderer arguments") }
} catch {
    FileHandle.standardError.write(Data("Brand asset error: \(error)\n".utf8))
    exit(1)
}
