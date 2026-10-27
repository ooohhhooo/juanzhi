# Windows OCR 诊断（CI 里用）：判断 ocr.ps1 对 samples/g4-2025-page1.png 返回「一行都没识别出来」是【脚本的问题】还是【环境的问题】。
#
#   pwsh -File tests/e2e/ocr-diagnose.ps1 -OcrScript <ocr.ps1> -Sample samples/g4-2025-page1.png -OutDir smoke-artifacts
#
# 已查明的根因（2026-10）：样张是 8 位 RGBA PNG，【背景全透明（alpha=0，颜色 0,0,0）、字是黑的】。不铺白底直接按 Premultiplied 送进引擎，整张图就是一片黑，
# en-US 和 zh-Hans 两个引擎都读出 0 行。这是脚本没处理透明通道（ocr.ps1 现在会先铺白底），和语言包、Windows Server 无关。
# 这个脚本用对照实验把「脚本 / 环境 / 图片」三种情况分开，并在 CI 上持续守着：
#   A  对照图（白底黑字，不透明 24 位 PNG）：先用【照抄微软官方示例的极简识别代码】（minimal，只用 GetSoftwareBitmapAsync() + RecognizeAsync + Text），
#      再用 ocr.ps1，各识别一次，打出 Text 长度和 Lines.Count。极简代码也读不出来 → 环境问题（ENV）。
#   B  透明背景对照图（Format32bppArgb，背景 alpha=0、黑字，和样张同样的结构）：极简代码读不出来、ocr.ps1 读得出来 → 证明脚本的铺白底生效。
#   C  样张：ocr.ps1 识别；再把样张拍平后识别，对比。
# 结论写进 OutDir/ocr-diagnose.json，日志里一行说明：
#   ENV     极简代码连不透明的对照图都读不出（且 ocr.ps1 的退出码是 2 / 3 或「跑成功但 0 行」，不是崩溃） → 这台机器上的 OCR 引擎不工作（环境限制，不是脚本的错）。只发警告，不让构建失败，也【不算 OCR 通过】。
#   SCRIPT  对照图能读，但 ocr.ps1 读不出样张 / 透明对照图，而拍平后的样张能读 → 脚本处理透明通道有问题。让构建失败。
#   IMAGE   对照图能读，样张拍平前后都读不出 → 样张本身（字太小 / 版面）引擎读不出。只发警告。
#   OK      ocr.ps1 读出了样张。
param(
    [Parameter(Mandatory = $true)][string]$OcrScript,
    [Parameter(Mandatory = $true)][string]$Sample,
    [string]$OutDir = 'smoke-artifacts'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ocr-diag-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null

function New-ControlImage([string]$path, [bool]$transparent) {
    $fmt = if ($transparent) { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb } else { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb }
    $bmp = New-Object System.Drawing.Bitmap 1400, 380, $fmt
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    if ($transparent) { $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0)) } else { $g.Clear([System.Drawing.Color]::White) }
    $g.TextRenderingHint = if ($transparent) { [System.Drawing.Text.TextRenderingHint]::AntiAlias } else { [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit }
    $font = New-Object System.Drawing.Font('Arial', 36)
    $g.DrawString('HELLO WORLD 123', $font, [System.Drawing.Brushes]::Black, 20, 10)
    $g.DrawString('1. A. sunny B. windy C. weather', $font, [System.Drawing.Brushes]::Black, 20, 120)
    $g.DrawString('2. A. sheep B. hen C. farm', $font, [System.Drawing.Brushes]::Black, 20, 230)
    $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$control = Join-Path $tmp 'control-opaque.png'; New-ControlImage $control $false
$controlT = Join-Path $tmp 'control-transparent.png'; New-ControlImage $controlT $true

# 样张拍平（铺白底，24 位 RGB）
$flat = Join-Path $tmp 'sample-flat.png'
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Sample).Path)
$sampleInfo = "$($src.Width)x$($src.Height) $($src.PixelFormat)"
$fb = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$fg = [System.Drawing.Graphics]::FromImage($fb)
$fg.Clear([System.Drawing.Color]::White)
$fg.DrawImage($src, 0, 0, $src.Width, $src.Height)
$fg.Dispose(); $fb.Save($flat, [System.Drawing.Imaging.ImageFormat]::Png); $fb.Dispose(); $src.Dispose()

# 极简识别代码：照抄微软官方示例的写法（GetSoftwareBitmapAsync() 不带参数、OcrEngine 用用户语言、直接取 Text），不做任何额外处理
$minimal = Join-Path $tmp 'minimal-ocr.ps1'
@'
param([string]$Path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$getAwaiterBaseMethod = [WindowsRuntimeSystemExtensions].GetMember('GetAwaiter').Where({ $PSItem.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }) | Select-Object -First 1
function Await($WinRtTask, $ResultType) { $getAwaiterBaseMethod.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask)).GetResult() }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output 'NOENGINE'; exit 0 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$text = [string]$result.Text
[ordered]@{ lang = $engine.RecognizerLanguage.LanguageTag; pixelFormat = "$($bitmap.BitmapPixelFormat)"; alpha = "$($bitmap.BitmapAlphaMode)"; linesCount = [int]$result.Lines.Count; textLength = $text.Length; text = $text.Substring(0, [Math]::Min(200, $text.Length)) } | ConvertTo-Json -Compress
'@ | Out-File $minimal -Encoding ascii

function Invoke-Minimal([string]$image, [string]$tag) {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $minimal $image 2>&1 | Out-String
    $o = $null; try { $o = $out.Trim() | ConvertFrom-Json } catch { }
    $n = if ($o) { [int]$o.linesCount } else { -1 }
    $len = if ($o) { [int]$o.textLength } else { -1 }
    Write-Host ("[minimal:{0}] lines={1} textLength={2} pixelFormat={3} alpha={4} lang={5} text=[{6}]" -f $tag, $n, $len, $o.pixelFormat, $o.alpha, $o.lang, $o.text)
    if (-not $o) { Write-Host $out }
    return [ordered]@{ tag = "minimal:$tag"; lines = $n; textLength = $len; raw = $out.Trim() }
}

function Invoke-OcrScript([string]$image, [string]$tag) {
    $errFile = Join-Path $tmp "$tag.err.txt"
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $OcrScript $image -Diag 2>$errFile
    $code = $LASTEXITCODE
    $diag = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { '' }
    $n = -1; $lang = ''; $first = ''
    try {
        $o = ($json | Out-String).Trim() | ConvertFrom-Json
        $n = @($o.lines).Count; $lang = $o.lang
        if ($n -gt 0) { $first = (@($o.lines) | Select-Object -First 3 | ForEach-Object { $_.text }) -join ' | ' }
    } catch { }
    Write-Host ("[ocr.ps1:{0}] exit={1} lines={2} lang={3} first=[{4}]" -f $tag, $code, $n, $lang, $first)
    if ($diag) { Write-Host $diag }
    return [ordered]@{ tag = "ocr.ps1:$tag"; exitCode = $code; lines = $n; lang = $lang; first = $first; diag = $diag }
}

$mControl = Invoke-Minimal $control 'control-opaque'
$mControlT = Invoke-Minimal $controlT 'control-transparent'
$mSample = Invoke-Minimal (Resolve-Path $Sample).Path 'sample'
$rControl = Invoke-OcrScript $control 'control-opaque'
$rControlT = Invoke-OcrScript $controlT 'control-transparent'
$rSample = Invoke-OcrScript (Resolve-Path $Sample).Path 'sample-rgba'
$rFlat = Invoke-OcrScript $flat 'sample-flat-rgb'

$caps = ''
try { $caps = (Get-WindowsCapability -Online | Where-Object Name -like 'Language.OCR*' | ForEach-Object { "$($_.Name)=$($_.State)" }) -join '; ' } catch { }

# 判定（评审 P2-6）：脚本崩溃（lines = -1 / 退出码不是 0）和「读了但 0 行」要分开；极简代码能读而 ocr.ps1 读不出，永远是脚本的问题
$psBroken = { param($r) $r.exitCode -ne 0 -or $r.lines -lt 0 }
$minimalReadsControl = $mControl.textLength -gt 0
$psReadsControl = ($rControl.exitCode -eq 0) -and ($rControl.lines -gt 0)
$note = ''
if (-not $minimalReadsControl -and $psReadsControl) {
    # 极简对照代码读不出，但 ocr.ps1 读得出对照图：对照代码自己有问题（比如用户语言引擎和 ocr.ps1 选的不同），ocr.ps1 是好的——只记一条说明，继续看样张
    $note = "（说明：极简对照代码读不出不透明对照图，但 ocr.ps1 读出了 $($rControl.lines) 行：问题在对照代码这一边，不是 ocr.ps1 的错）"
}
if (-not $minimalReadsControl -and -not $psReadsControl -and (($rControl.exitCode -in @(2, 3)) -or ($rControl.exitCode -eq 0 -and $rControl.lines -eq 0))) {
    # 两边都读不出对照图，ocr.ps1 是「引擎 / 语言包不可用」（退出码 2 / 3）或「跑成功但 0 行」：引擎本身不工作
    $verdict = 'ENV'; $why = '极简识别代码和 ocr.ps1 连白底黑字的大号英文（不透明对照图）都读不出来：这台机器上的 OCR 引擎不工作，是环境限制，不是 ocr.ps1 的错；这一项不能算 OCR 通过，要在 Windows 真机上验证'
}
elseif ($minimalReadsControl -and -not $psReadsControl) {
    # 只有「极简代码读得出而 ocr.ps1 读不出」才是脚本的问题
    $verdict = 'SCRIPT'; $why = "极简代码能读出对照图（$($mControl.textLength) 个字符），但 ocr.ps1 读它失败（退出码 $($rControl.exitCode)，$($rControl.lines) 行）：ocr.ps1 本身有问题"
}
elseif (-not $minimalReadsControl -and -not $psReadsControl) {
    $verdict = 'SCRIPT'; $why = "极简代码读不出对照图，而 ocr.ps1 也失败了（退出码 $($rControl.exitCode)，$($rControl.lines) 行，不是引擎不可用的那种）：按脚本问题处理，请看日志"
}
elseif ((& $psBroken $rSample) -or (& $psBroken $rControlT)) { $verdict = 'SCRIPT'; $why = "ocr.ps1 处理样张 / 透明背景对照图时崩溃（退出码 $($rSample.exitCode) / $($rControlT.exitCode)）" }
elseif ($rSample.lines -gt 0 -and $rControlT.lines -gt 0) { $verdict = 'OK'; $why = "ocr.ps1 识别出样张 $($rSample.lines) 行、透明背景对照图 $($rControlT.lines) 行（极简代码对透明背景对照图读出 $($mControlT.textLength) 个字符、对样张 $($mSample.textLength) 个字符——为 0 就证实了透明背景是根因）" }
elseif ($rFlat.lines -gt 0) { $verdict = 'SCRIPT'; $why = 'ocr.ps1 读不出带透明通道的图，但铺白底后的样张能读：脚本处理透明通道有问题' }
else { $verdict = 'IMAGE'; $why = '对照图能读，但样张（拍平前后）都读不出：引擎读不出这张样张（字太小 / 版面）' }
if ($note) { $why = "$why $note" }

$summary = [ordered]@{ verdict = $verdict; why = $why; sample = $sampleInfo; capabilities = $caps; minimal = @($mControl, $mControlT, $mSample); ocrPs1 = @($rControl, $rControlT, $rSample, $rFlat) }
$summary | ConvertTo-Json -Depth 6 | Out-File (Join-Path $OutDir 'ocr-diagnose.json') -Encoding utf8
Write-Host "OCR 诊断结论：$verdict —— $why"
if ($verdict -eq 'SCRIPT') { exit 1 }
if ($verdict -eq 'ENV' -or $verdict -eq 'IMAGE') { Write-Host "::warning title=Windows OCR 诊断::$verdict - $why" }
exit 0
