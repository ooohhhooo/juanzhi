#!/bin/bash
# 构建 macOS 通用二进制 native/macos/bin/ewb-ocr（arm64 + x86_64，最低 macOS 13）
# 用法：bash scripts/build-ocr-mac.sh   （需要 Xcode 命令行工具；OCR/图片转换须在沙箱外验证）
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=native/macos/bin
TMP="${TMPDIR:-/tmp}/ewb-ocr-build"
mkdir -p "$OUT" "$TMP/mc"
for ARCH in arm64 x86_64; do
  swiftc -O -module-cache-path "$TMP/mc" -target "$ARCH-apple-macosx13.0" native/macos/ocr.swift -o "$TMP/ewb-ocr-$ARCH"
done
lipo -create "$TMP/ewb-ocr-arm64" "$TMP/ewb-ocr-x86_64" -output "$OUT/ewb-ocr"
codesign --force --sign - "$OUT/ewb-ocr"
lipo -info "$OUT/ewb-ocr"
