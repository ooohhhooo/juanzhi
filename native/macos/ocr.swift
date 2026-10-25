import Foundation
import Vision
import CoreGraphics
import ImageIO

struct Line: Codable {
  let text: String
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let conf: Double
}

struct Output: Codable {
  let lines: [Line]
  let width: Int
  let height: Int
}

func stderr(_ msg: String) {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
}

guard CommandLine.arguments.count >= 2 else {
  stderr("用法: ewb-ocr <image.png>   |   ewb-ocr --convert <输入图片> <输出.png>")
  exit(2)
}

// --convert：用 ImageIO 解码（支持 HEIC，并按 EXIF 方向旋转像素），输出方向正确的 PNG
if CommandLine.arguments[1] == "--convert" {
  guard CommandLine.arguments.count >= 4 else {
    stderr("用法: ewb-ocr --convert <输入图片> <输出.png>")
    exit(2)
  }
  let inURL = URL(fileURLWithPath: CommandLine.arguments[2])
  let outURL = URL(fileURLWithPath: CommandLine.arguments[3])
  guard let src = CGImageSourceCreateWithURL(inURL as CFURL, nil) else {
    stderr("无法读取图片: \(inURL.path)")
    exit(1)
  }
  let opts: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceThumbnailMaxPixelSize: 8192
  ]
  guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary),
        let dest = CGImageDestinationCreateWithURL(outURL as CFURL, "public.png" as CFString, 1, nil) else {
    stderr("无法转换图片: \(inURL.path)")
    exit(1)
  }
  CGImageDestinationAddImage(dest, img, nil)
  guard CGImageDestinationFinalize(dest) else {
    stderr("无法写出 PNG: \(outURL.path)")
    exit(1)
  }
  print("{\"width\":\(img.width),\"height\":\(img.height)}")
  exit(0)
}

let imagePath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: imagePath)

guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  stderr("无法读取图片: \(imagePath)")
  exit(1)
}

let width = cgImage.width
let height = cgImage.height

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
  try handler.perform([request])
} catch {
  stderr("Vision 识别失败: \(error.localizedDescription)")
  exit(1)
}

var lines: [Line] = []
for obs in request.results ?? [] {
  guard let candidate = obs.topCandidates(1).first else { continue }
  let box = obs.boundingBox
  lines.append(Line(
    text: candidate.string,
    x: box.minX,
    y: 1.0 - box.maxY,
    w: box.width,
    h: box.height,
    conf: Double(candidate.confidence)
  ))
}

let output = Output(lines: lines, width: width, height: height)
let encoder = JSONEncoder()
let json = try! encoder.encode(output)
FileHandle.standardOutput.write(json)
