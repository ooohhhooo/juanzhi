import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// 用法：render <pdf> <outdir> <page> [<page>...]   把指定页（1 起）渲染成 PNG（只有像素，没有文字层）
let args = CommandLine.arguments
guard args.count >= 4, let doc = CGPDFDocument(URL(fileURLWithPath: args[1]) as CFURL) else { print("bad args"); exit(1) }
for a in args[3...] {
    guard let n = Int(a), let page = doc.page(at: n) else { continue }
    let box = page.getBoxRect(.mediaBox)
    let scale: CGFloat = 2
    let w = Int(box.width * scale), h = Int(box.height * scale)
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -box.origin.x, y: -box.origin.y)
    ctx.drawPDFPage(page)
    guard let img = ctx.makeImage() else { continue }
    let url = URL(fileURLWithPath: args[2]).appendingPathComponent("page-\(n).png") as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
}
