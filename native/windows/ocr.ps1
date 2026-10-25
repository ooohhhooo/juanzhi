# ewb-ocr Windows 版：调用 Windows.Media.Ocr（Windows 10 1809+ / Windows 11，PowerShell 5.1）
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <image.png>   识别图片
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Check        只探测引擎与语言，输出 {"lang":"..."}
#
# stdout 只输出一段 JSON（识别时）：{ lines: [{text,x,y,w,h,conf}], width, height, lang }，坐标为 0-1 归一化、左上角原点。
# 退出码：1 读图/识别失败/尺寸超限；2 WinRT 类型加载失败；3 没有可用的 OCR 语言包。
# 本文件保存为带 BOM 的 UTF-8：PowerShell 5.1 对无 BOM 脚本按系统 ANSI（中文系统为 GBK）读取，会读坏中文。

param(
    [Parameter(Position = 0)]
    [string]$ImagePath,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Write-Err([string]$msg) {
    [Console]::Error.WriteLine($msg)
}

# ---- 加载 WinRT 类型（结果类型要在调用 Await 时显式传入，不能靠运行时推断）----
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
} catch {
    Write-Err "无法加载 WinRT 组件: $_"
    exit 2
}

# AsTask<TResult>(IAsyncOperation<TResult>) 的泛型方法定义，只取一次
$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

# 等待 IAsyncOperation<T> 完成。$ResultType 必须由调用点显式给出。
function Await([object]$AsyncOp, [Type]$ResultType) {
    $task = $script:AsTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($AsyncOp))
    [void]$task.Wait(-1)
    return $task.Result
}

# 创建 OCR 引擎：优先简体中文，其次用户语言；都没有返回 $null
function New-OcrEngine {
    $engine = $null
    try {
        $zh = New-Object Windows.Globalization.Language 'zh-Hans-CN'
        if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($zh)) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zh)
        }
    } catch { }
    if (-not $engine) {
        try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }
    }
    return $engine
}

$engine = New-OcrEngine
if (-not $engine) {
    Write-Err '无法创建 OCR 引擎：未安装任何 OCR 语言包'
    exit 3
}
$langTag = $engine.RecognizerLanguage.LanguageTag

if ($Check) {
    [Console]::Out.Write((@{ lang = $langTag } | ConvertTo-Json -Compress))
    exit 0
}

if (-not $ImagePath -or -not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) {
    Write-Err "无法读取图片: $ImagePath"
    exit 1
}
$ImagePath = (Resolve-Path -LiteralPath $ImagePath).ProviderPath

$stream = $null
try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

    $imgWidth = [int]$decoder.PixelWidth
    $imgHeight = [int]$decoder.PixelHeight
    $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($imgWidth -gt $maxDim -or $imgHeight -gt $maxDim) {
        Write-Err "图片尺寸 (${imgWidth}x${imgHeight}) 超过 OCR 最大限制 ($maxDim)"
        exit 1
    }

    # 统一成 Bgra8/Premultiplied，调色板、16 位 PNG 也能被 OCR 接受
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
            [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $ocrResult = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = New-Object System.Collections.ArrayList
    foreach ($ocrLine in $ocrResult.Lines) {
        $minX = [double]::MaxValue; $minY = [double]::MaxValue
        $maxX = [double]::MinValue; $maxY = [double]::MinValue
        $wordCount = 0
        foreach ($word in $ocrLine.Words) {
            $r = $word.BoundingRect
            if ($r.X -lt $minX) { $minX = $r.X }
            if ($r.Y -lt $minY) { $minY = $r.Y }
            if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
            if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
            $wordCount++
        }
        if ($wordCount -eq 0) { continue }

        # 用 OcrLine.Text（保留英文单词间空格），再去掉相邻汉字之间的空格。
        # 必须用环视：普通的 ([CJK])\s+([CJK]) 不重叠匹配，会漏掉一半（"中 文 字" 只得到 "中文 字"）。
        $text = $ocrLine.Text
        $cjk = '[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]'
        $text = [regex]::Replace($text, "(?<=$cjk)\s+(?=$cjk)", '')

        [void]$lines.Add(@{
                text = $text
                x    = [Math]::Round($minX / $imgWidth, 6)
                y    = [Math]::Round($minY / $imgHeight, 6)
                w    = [Math]::Round(($maxX - $minX) / $imgWidth, 6)
                h    = [Math]::Round(($maxY - $minY) / $imgHeight, 6)
                conf = 0.8   # Windows OCR 不提供置信度，固定值
            })
    }

    $output = @{ lines = $lines; width = $imgWidth; height = $imgHeight; lang = $langTag }
    [Console]::Out.Write(($output | ConvertTo-Json -Depth 4 -Compress))
} catch {
    Write-Err "OCR 识别失败: $_"
    exit 1
} finally {
    if ($stream) { $stream.Dispose() }
}
