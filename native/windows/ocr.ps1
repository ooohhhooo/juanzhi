# ewb-ocr Windows 版：调用 Windows.Media.Ocr（Windows 10 1809+ / Windows 11，PowerShell 5.1）
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <image.png>   识别图片
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Check        只探测引擎与语言，输出 {"lang":"..."}
#
# stdout 只输出一段 JSON（识别时）：{ lines: [{text,x,y,w,h,conf}], width, height, lang }，坐标为 0-1 归一化、左上角原点。
# 退出码：1 读图/识别失败/尺寸超限；2 WinRT 类型加载失败；3 没有可用的 OCR 语言包。
# 带透明通道（alpha）的 PNG 先铺在白底上再识别：透明背景的像素颜色通常是 (0,0,0)，不铺白底整张图就是一片黑，引擎一行都读不出来（samples/g4-2025-page1.png 就是这样：背景全透明、字是黑的，CI 上两个语言的引擎都返回 0 行）。
# 第一遍一行都没识别出来时，依次再试：灰度图、放大 2 倍（Windows OCR 对 Bgra8 之外的输入、过小的字有时更好）；`-Diag` 把每一遍的情况写到 stderr（排查「返回空」是脚本问题还是环境问题用）。
# 本文件保存为带 BOM 的 UTF-8：PowerShell 5.1 对无 BOM 脚本按系统 ANSI（中文系统为 GBK）读取，会读坏中文。

param(
    [Parameter(Position = 0)]
    [string]$ImagePath,
    [switch]$Check,
    [switch]$Diag
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
    $null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics, ContentType = WindowsRuntime]
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

function Write-Diag([string]$msg) { if ($Diag) { [Console]::Error.WriteLine("[ocr-diag] $msg") } }

# 把一次识别的结果转成输出行（坐标按「这次送进引擎的位图」的宽高归一化，缩放过的位图也一样对得回原图）
function Convert-OcrLines($ocrResult, [int]$bw, [int]$bh) {
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
                x    = [Math]::Round($minX / $bw, 6)
                y    = [Math]::Round($minY / $bh, 6)
                w    = [Math]::Round(($maxX - $minX) / $bw, 6)
                h    = [Math]::Round(($maxY - $minY) / $bh, 6)
                conf = 0.8   # Windows OCR 不提供置信度，固定值
            })
    }
    return ,$lines
}

# 打开图片得到解码器（流要一直开到识别结束）
function Open-Decoder([string]$path) {
    $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $st = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($st)) ([Windows.Graphics.Imaging.BitmapDecoder])
    return @{ stream = $st; decoder = $dec }
}

# 把带透明通道的图铺在白底上，存成不透明的 24 位 PNG（临时文件），返回路径；失败返回 $null
function Convert-ToOpaquePng([string]$path) {
    try {
        Add-Type -AssemblyName System.Drawing
        $img = [System.Drawing.Image]::FromFile($path)
        try {
            $bmp = New-Object System.Drawing.Bitmap $img.Width, $img.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.Clear([System.Drawing.Color]::White)
            $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
            $g.Dispose()
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('ewb-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
            $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            return $tmp
        } finally { $img.Dispose() }
    } catch {
        Write-Diag "铺白底失败：$_"
        return $null
    }
}

$stream = $null
$flatFile = $null
try {
    $opened = Open-Decoder $ImagePath
    $stream = $opened.stream
    $decoder = $opened.decoder
    # 有透明通道（RGBA / 灰度+alpha / 调色板带透明）：铺白底后用不透明的图重新打开
    if ($decoder.BitmapAlphaMode -ne [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore) {
        $flatFile = Convert-ToOpaquePng $ImagePath
        if ($flatFile) {
            $stream.Dispose()
            $opened = Open-Decoder $flatFile
            $stream = $opened.stream
            $decoder = $opened.decoder
            Write-Diag "原图有透明通道（alpha=Straight），已铺白底：$flatFile"
        }
    }

    $imgWidth = [int]$decoder.PixelWidth
    $imgHeight = [int]$decoder.PixelHeight
    $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($imgWidth -gt $maxDim -or $imgHeight -gt $maxDim) {
        Write-Err "图片尺寸 (${imgWidth}x${imgHeight}) 超过 OCR 最大限制 ($maxDim)"
        exit 1
    }
    Write-Diag "decoder: ${imgWidth}x${imgHeight} pixelFormat=$($decoder.BitmapPixelFormat) alpha=$($decoder.BitmapAlphaMode) engine=$langTag maxDim=$maxDim languages=$(([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ',')"

    # 第一遍：统一成 Bgra8/Premultiplied，调色板、16 位 PNG 也能被 OCR 接受
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
            [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $ocrResult = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = Convert-OcrLines $ocrResult ([int]$bitmap.PixelWidth) ([int]$bitmap.PixelHeight)
    Write-Diag "attempt 1 (Bgra8/Premultiplied): lines=$($lines.Count) textLength=$($ocrResult.Text.Length)"

    # 一行都没有：换灰度图、放大 2 倍再试（只在第一遍为空时才做；失败不影响结果）
    if ($lines.Count -eq 0) {
        try {
            $gray = Await ($decoder.GetSoftwareBitmapAsync(
                    [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8,
                    [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $r2 = Await ($engine.RecognizeAsync($gray)) ([Windows.Media.Ocr.OcrResult])
            $lines = Convert-OcrLines $r2 ([int]$gray.PixelWidth) ([int]$gray.PixelHeight)
            Write-Diag "attempt 2 (Gray8): lines=$($lines.Count)"
        } catch { Write-Diag "attempt 2 failed: $_" }
    }
    if ($lines.Count -eq 0 -and ($imgWidth * 2) -le $maxDim -and ($imgHeight * 2) -le $maxDim) {
        try {
            $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics, ContentType = WindowsRuntime]
            $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
            $tf.ScaledWidth = [uint32]($imgWidth * 2)
            $tf.ScaledHeight = [uint32]($imgHeight * 2)
            $big = Await ($decoder.GetSoftwareBitmapAsync(
                    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
                    $tf,
                    [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
                    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $r3 = Await ($engine.RecognizeAsync($big)) ([Windows.Media.Ocr.OcrResult])
            $lines = Convert-OcrLines $r3 ([int]$big.PixelWidth) ([int]$big.PixelHeight)
            Write-Diag "attempt 3 (2x scale): lines=$($lines.Count)"
        } catch { Write-Diag "attempt 3 failed: $_" }
    }

    $output = @{ lines = $lines; width = $imgWidth; height = $imgHeight; lang = $langTag }
    [Console]::Out.Write(($output | ConvertTo-Json -Depth 4 -Compress))
} catch {
    Write-Err "OCR 识别失败: $_"
    exit 1
} finally {
    if ($stream) { $stream.Dispose() }
    if ($flatFile -and (Test-Path -LiteralPath $flatFile)) { Remove-Item -LiteralPath $flatFile -Force -ErrorAction SilentlyContinue }
}
