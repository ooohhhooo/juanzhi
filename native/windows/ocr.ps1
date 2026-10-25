# ewb-ocr Windows 版 — 调用 Windows.Media.Ocr
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <image.png>
# 输出: JSON { lines: [{text, x, y, w, h, conf}], width, height }
# 需要 Windows 10 1809+ 或 Windows 11

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$ImagePath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Error.NewLine = "`n"

function Write-Err([string]$msg) {
    [Console]::Error.WriteLine($msg)
}

# 验证文件
if (-not (Test-Path $ImagePath)) {
    Write-Err "无法读取图片: $ImagePath"
    exit 1
}

$ImagePath = (Resolve-Path $ImagePath).Path

# 加载 WinRT 类型
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
} catch {
    Write-Err "无法加载 WinRT 组件: $_"
    exit 2
}

# 辅助函数：等待 IAsyncOperation 完成
function Await-AsyncOp {
    param([object]$AsyncOp)

    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1

    if (-not $asTaskMethod) {
        throw "无法找到 AsTask 方法"
    }

    $resultType = $AsyncOp.GetType().GetInterfaces() |
        Where-Object { $_.IsGenericType -and $_.GetGenericTypeDefinition().Name -eq 'IAsyncOperation`1' } |
        ForEach-Object { $_.GetGenericArguments()[0] } |
        Select-Object -First 1

    $genericMethod = $asTaskMethod.MakeGenericMethod($resultType)
    $task = $genericMethod.Invoke($null, @($AsyncOp))
    $task.Wait()

    if ($task.IsFaulted) {
        throw $task.Exception.InnerException
    }

    return $task.Result
}

function Await-AsyncAction {
    param([object]$AsyncAction)

    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
        } | Select-Object -First 1

    if (-not $asTaskMethod) {
        throw "无法找到 AsTask(IAsyncAction) 方法"
    }

    $task = $asTaskMethod.Invoke($null, @($AsyncAction))
    $task.Wait()

    if ($task.IsFaulted) {
        throw $task.Exception.InnerException
    }
}

try {
    # 打开文件
    $fileOp = [Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)
    $file = Await-AsyncOp $fileOp

    # 打开文件流
    $streamOp = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
    $stream = Await-AsyncOp $streamOp

    # 解码图片
    $decoderOp = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
    $decoder = Await-AsyncOp $decoderOp

    $imgWidth = [int]$decoder.PixelWidth
    $imgHeight = [int]$decoder.PixelHeight

    # 检查尺寸限制
    $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($imgWidth -gt $maxDim -or $imgHeight -gt $maxDim) {
        Write-Err "图片尺寸 (${imgWidth}x${imgHeight}) 超过 OCR 最大限制 ($maxDim)"
        exit 1
    }

    # 获取 SoftwareBitmap
    $bitmapOp = $decoder.GetSoftwareBitmapAsync()
    $bitmap = Await-AsyncOp $bitmapOp

    # 创建 OCR 引擎：先尝试中文，再回退到用户语言
    $engine = $null

    try {
        $zhLang = New-Object Windows.Globalization.Language "zh-Hans-CN"
        if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($zhLang)) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zhLang)
        }
    } catch {
        Write-Err "中文语言包不可用，尝试回退"
    }

    if (-not $engine) {
        try {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        } catch {}
    }

    if (-not $engine) {
        Write-Err "无法创建 OCR 引擎：未安装任何 OCR 语言包"
        exit 3
    }

    # 执行识别
    $ocrOp = $engine.RecognizeAsync($bitmap)
    $ocrResult = Await-AsyncOp $ocrOp

    # 构建结果
    $lines = @()

    foreach ($ocrLine in $ocrResult.Lines) {
        # 合并 Words 的 BoundingRect
        $minX = [double]::MaxValue
        $minY = [double]::MaxValue
        $maxX = [double]::MinValue
        $maxY = [double]::MinValue

        foreach ($word in $ocrLine.Words) {
            $rect = $word.BoundingRect

            if ($rect.X -lt $minX) { $minX = $rect.X }
            if ($rect.Y -lt $minY) { $minY = $rect.Y }
            if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
            if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }

        }

        # 用 OcrLine.Text（保留英文单词间空格），而不是拼接 Words
        $lineText = $ocrLine.Text

        # CJK 字符之间去除多余空格
        $lineText = [regex]::Replace($lineText, '([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])', '$1$2')

        # 归一化坐标
        $nx = [Math]::Round($minX / $imgWidth, 6)
        $ny = [Math]::Round($minY / $imgHeight, 6)
        $nw = [Math]::Round(($maxX - $minX) / $imgWidth, 6)
        $nh = [Math]::Round(($maxY - $minY) / $imgHeight, 6)

        $lines += @{
            text = $lineText
            x = $nx
            y = $ny
            w = $nw
            h = $nh
            conf = 0.8  # Windows OCR 不提供置信度，使用固定值
        }
    }

    # 清理
    $stream.Dispose()

    # 输出 JSON
    $output = @{
        lines = $lines
        width = $imgWidth
        height = $imgHeight
    }

    $json = $output | ConvertTo-Json -Depth 4 -Compress
    [Console]::Out.Write($json)

} catch {
    Write-Err "OCR 识别失败: $_"
    exit 1
}
