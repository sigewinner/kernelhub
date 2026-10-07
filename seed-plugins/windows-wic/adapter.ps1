#Requires -Version 5.1
<#
    Windows GDI+/WIC image kernel - CKP 1.0 adapter (KernelHub built-in).

    Zero third-party dependency: uses only System.Drawing, which ships with
    Windows. Gives PNG / JPEG / BMP / GIF / TIFF / ICO round-trips even on a
    machine with no Python imaging library at all.

    NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads
    .ps1 files using the ANSI code page unless they carry a UTF-8 BOM, so
    non-ASCII source here would be mis-decoded. All human-facing Chinese text
    lives in kernel.json instead.
#>
param(
    [Alias("ckp-job", "ckp_job")]
    [string]$CkpJob
)

$ErrorActionPreference = 'Stop'

# NDJSON must reach the host as UTF-8 without BOM.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # Older hosts may not allow changing the console encoding; continue.
}

$KernelId = 'windows-wic'
$KernelVersion = '1.0.0'
$EngineName = 'Windows GDI+ / WIC (System.Drawing)'

function Emit-Event {
    param([Parameter(Mandatory = $true)]$Event)
    $json = $Event | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Emit-Log {
    param([string]$Message, [string]$Level = 'info')
    Emit-Event ([ordered]@{ type = 'log'; level = $Level; message = $Message })
}

function Emit-Progress {
    param([double]$Value, [string]$Message = '')
    Emit-Event ([ordered]@{ type = 'progress'; value = $Value; message = $Message })
}

function Emit-Error {
    param([string]$JobId, [string]$Code, [string]$Message, [string]$Detail = '')
    $retryable = $Code -in @('TIMEOUT', 'CANCELLED', 'ENGINE_CRASH', 'OUTPUT_NOT_WRITABLE', 'INTERNAL')
    $evt = [ordered]@{
        type      = 'error'
        ok        = $false
        ckp       = '1.0'
        job_id    = $JobId
        code      = $Code
        message   = $Message
        retryable = $retryable
    }
    if ($Detail) { $evt.detail = $Detail }
    Emit-Event $evt
}

function Get-ImageFormat {
    param([string]$Fmt)
    switch ($Fmt.ToLower()) {
        'png'  { return [System.Drawing.Imaging.ImageFormat]::Png }
        'jpg'  { return [System.Drawing.Imaging.ImageFormat]::Jpeg }
        'jpeg' { return [System.Drawing.Imaging.ImageFormat]::Jpeg }
        'jpe'  { return [System.Drawing.Imaging.ImageFormat]::Jpeg }
        'bmp'  { return [System.Drawing.Imaging.ImageFormat]::Bmp }
        'gif'  { return [System.Drawing.Imaging.ImageFormat]::Gif }
        'tif'  { return [System.Drawing.Imaging.ImageFormat]::Tiff }
        'tiff' { return [System.Drawing.Imaging.ImageFormat]::Tiff }
        'emf'  { return [System.Drawing.Imaging.ImageFormat]::Emf }
        'wmf'  { return [System.Drawing.Imaging.ImageFormat]::Wmf }
        'exif' { return [System.Drawing.Imaging.ImageFormat]::Exif }
        default { return $null }
    }
}

function Get-QualityEncoder {
    param([string]$MimeType)
    $codecs = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()
    foreach ($c in $codecs) {
        if ($c.MimeType -eq $MimeType) { return $c }
    }
    return $null
}

function Resolve-Color {
    param([string]$Text, $Fallback)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Fallback }
    $t = $Text.Trim()
    try {
        if ($t.StartsWith('#')) {
            return [System.Drawing.ColorTranslator]::FromHtml($t)
        }
        return [System.Drawing.Color]::FromName($t)
    } catch {
        return $Fallback
    }
}

function Get-Param {
    param($Params, [string]$Name, $Default)
    if ($null -eq $Params) { return $Default }
    $prop = $Params.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    if ($null -eq $prop.Value) { return $Default }
    if ($prop.Value -is [string] -and [string]::IsNullOrWhiteSpace($prop.Value)) { return $Default }
    return $prop.Value
}

function Get-FlipMode {
    param($Params)
    $raw = [string](Get-Param $Params 'flip' 'none')
    switch ($raw.ToLower()) {
        'horizontal' { return 'horizontal' }
        'vertical'   { return 'vertical' }
        'both'       { return 'both' }
        default      { return 'none' }
    }
}

# --------------------------------------------------------------------------- #
# Handshake
# --------------------------------------------------------------------------- #

Emit-Event ([ordered]@{
    type    = 'hello'
    ckp     = '1.0'
    kernel  = $KernelId
    version = $KernelVersion
    engine  = $EngineName
    pid     = $PID
})

$Job = $null
try {
    if ($CkpJob -and (Test-Path -LiteralPath $CkpJob)) {
        $Job = Get-Content -LiteralPath $CkpJob -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $raw = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($raw)) {
            Emit-Error '' 'BAD_JOB' 'No job supplied: neither --ckp-job nor stdin contained JSON.'
            exit 2
        }
        $Job = $raw | ConvertFrom-Json
    }
} catch {
    Emit-Error '' 'BAD_JOB' ("Failed to parse job JSON: " + $_.Exception.Message)
    exit 2
}

$JobId = [string]$Job.job_id

try {
    Add-Type -AssemblyName System.Drawing | Out-Null
} catch {
    Emit-Error $JobId 'DEPENDENCY_MISSING' ('System.Drawing is unavailable: ' + $_.Exception.Message)
    exit 3
}

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

$inputs = @($Job.inputs)
if ($inputs.Count -lt 1) {
    Emit-Error $JobId 'BAD_JOB' 'Job has no inputs.'
    exit 2
}
$outputs = @($Job.outputs)
if ($outputs.Count -lt 1) {
    Emit-Error $JobId 'BAD_JOB' 'Job has no outputs.'
    exit 2
}

$src = [string]$inputs[0].path
if (-not (Test-Path -LiteralPath $src)) {
    Emit-Error $JobId 'INPUT_NOT_FOUND' ("Input file not found: " + $src)
    exit 4
}
$dst = [string]$outputs[0].path

$outFormat = [string]$outputs[0].format
if ([string]::IsNullOrWhiteSpace($outFormat)) {
    $outFormat = [System.IO.Path]::GetExtension($dst).TrimStart('.').ToLower()
} else {
    $outFormat = $outFormat.ToLower()
}

$params = Get-Param $Job 'params' $null

$srcImage = $null
$workBitmap = $null
$graphics = $null

try {
    Emit-Progress 0.15 'Loading image'
    $bytes = [System.IO.File]::ReadAllBytes($src)
    $stream = New-Object System.IO.MemoryStream(, $bytes)
    try {
        $srcImage = [System.Drawing.Image]::FromStream($stream, $true, $true)
    } catch {
        Emit-Error $JobId 'INPUT_UNREADABLE' ("Cannot decode image: " + $_.Exception.Message) $_.ScriptStackTrace
        exit 4
    }

    $srcW = $srcImage.Width
    $srcH = $srcImage.Height
    Emit-Log ("source: {0}x{1} format={2}" -f $srcW, $srcH, $srcImage.RawFormat.Guid)

    # ---- geometry ------------------------------------------------------ #
    $resizeW = [int](Get-Param $params 'resize_w' 0)
    $resizeH = [int](Get-Param $params 'resize_h' 0)
    $keepAspect = [bool](Get-Param $params 'keep_aspect' $true)
    $rotate = [double](Get-Param $params 'rotate' 0)
    $flip = Get-FlipMode $params
    $grayscale = [bool](Get-Param $params 'grayscale' $false)

    $targetW = $srcW
    $targetH = $srcH
    if ($resizeW -gt 0 -or $resizeH -gt 0) {
        if ($keepAspect) {
            $ratio = 1.0
            if ($resizeW -gt 0 -and $resizeH -gt 0) {
                $ratio = [Math]::Min($resizeW / $srcW, $resizeH / $srcH)
            } elseif ($resizeW -gt 0) {
                $ratio = $resizeW / $srcW
            } else {
                $ratio = $resizeH / $srcH
            }
            $targetW = [Math]::Max(1, [int][Math]::Round($srcW * $ratio))
            $targetH = [Math]::Max(1, [int][Math]::Round($srcH * $ratio))
        } else {
            if ($resizeW -gt 0) { $targetW = $resizeW }
            if ($resizeH -gt 0) { $targetH = $resizeH }
        }
    }

    Emit-Progress 0.35 'Transforming'
    $workBitmap = New-Object System.Drawing.Bitmap($targetW, $targetH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($workBitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $backgroundColor = Resolve-Color ([string](Get-Param $params 'background' '#FFFFFF')) ([System.Drawing.Color]::White)
    $graphics.Clear($backgroundColor)

    if ($rotate -ne 0 -or $flip -ne 'none') {
        # Compose rotate/flip via a transform matrix around the canvas centre.
        $graphics.TranslateTransform($targetW / 2.0, $targetH / 2.0)
        if ($rotate -ne 0) { $graphics.RotateTransform([float]$rotate) }
        if ($flip -eq 'horizontal') { $graphics.ScaleTransform(-1, 1) }
        elseif ($flip -eq 'vertical') { $graphics.ScaleTransform(1, -1) }
        elseif ($flip -eq 'both') { $graphics.ScaleTransform(-1, -1) }
        $graphics.TranslateTransform(-$targetW / 2.0, -$targetH / 2.0)
    }

    if ($grayscale) {
        $matrix = New-Object System.Drawing.Imaging.ColorMatrix
        $matrix.Matrix00 = 0.299; $matrix.Matrix01 = 0.299; $matrix.Matrix02 = 0.299
        $matrix.Matrix10 = 0.587; $matrix.Matrix11 = 0.587; $matrix.Matrix12 = 0.587
        $matrix.Matrix20 = 0.114; $matrix.Matrix21 = 0.114; $matrix.Matrix22 = 0.114
        $matrix.Matrix33 = 1.0
        $matrix.Matrix44 = 1.0
        $attrs = New-Object System.Drawing.Imaging.ImageAttributes
        $attrs.SetColorMatrix($matrix)
        $rectDest = New-Object System.Drawing.Rectangle(0, 0, $targetW, $targetH)
        $graphics.DrawImage($srcImage, $rectDest, 0, 0, $srcW, $srcH, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
        $attrs.Dispose()
    } else {
        $graphics.DrawImage($srcImage, 0, 0, $targetW, $targetH)
    }

    $graphics.Dispose()
    $graphics = $null

    # ---- encode -------------------------------------------------------- #
    Emit-Progress 0.7 ('Encoding to ' + $outFormat)
    $dstDir = [System.IO.Path]::GetDirectoryName($dst)
    if ($dstDir -and -not (Test-Path -LiteralPath $dstDir)) {
        New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    }

    $quality = [int](Get-Param $params 'quality' 88)

    if ($outFormat -eq 'ico') {
        $hicon = $workBitmap.GetHicon()
        try {
            $icon = [System.Drawing.Icon]::FromHandle($hicon)
            $fileStream = [System.IO.File]::Create($dst)
            try { $icon.Save($fileStream) } finally { $fileStream.Dispose(); $icon.Dispose() }
        } finally {
            # Release the native icon handle.
            $destroy = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);' -Name 'IconCleanup' -Namespace 'KernelHub' -PassThru
            $destroy::DestroyIcon($hicon) | Out-Null
        }
    } else {
        $imageFormat = Get-ImageFormat $outFormat
        if ($null -eq $imageFormat) {
            Emit-Error $JobId 'UNSUPPORTED_FORMAT' ("Unsupported output format: " + $outFormat) 'GDI+ can write png/jpg/bmp/gif/tif/ico.'
            exit 1
        }
        if ($outFormat -in @('jpg', 'jpeg', 'jpe')) {
            $codec = Get-QualityEncoder 'image/jpeg'
            if ($null -ne $codec) {
                $encoder = [System.Drawing.Imaging.Encoder]::Quality
                $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
                $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($encoder, [int64]$quality)
                $workBitmap.Save($dst, $codec, $encoderParams)
                $encoderParams.Dispose()
            } else {
                $workBitmap.Save($dst, $imageFormat)
            }
        } else {
            $workBitmap.Save($dst, $imageFormat)
        }
    }

    if (-not (Test-Path -LiteralPath $dst)) {
        Emit-Error $JobId 'ARTIFACT_MISSING' ('Expected output was not written: ' + $dst)
        exit 1
    }

    $sizeBytes = (Get-Item -LiteralPath $dst).Length
    $finalW = $targetW
    $finalH = $targetH
    try {
        $probe = [System.Drawing.Image]::FromFile($dst)
        $finalW = $probe.Width
        $finalH = $probe.Height
        $probe.Dispose()
    } catch { }

    Emit-Progress 1.0 'Done'
    Emit-Event ([ordered]@{
        type    = 'artifact'
        path    = $dst
        format  = $outFormat
        bytes   = $sizeBytes
        primary = $true
        width   = $finalW
        height  = $finalH
        meta    = [ordered]@{ engine = $EngineName; width = $finalW; height = $finalH }
    })

    $stopwatch.Stop()
    Emit-Event ([ordered]@{
        type    = 'result'
        ok      = $true
        ckp     = '1.0'
        job_id  = $JobId
        kernel  = [ordered]@{ id = $KernelId; version = $KernelVersion }
        outputs = @([ordered]@{
            path   = $dst
            format = $outFormat
            bytes  = $sizeBytes
            width  = $finalW
            height = $finalH
        })
        metrics = [ordered]@{ duration_ms = $stopwatch.ElapsedMilliseconds; engine = $EngineName }
    })
    exit 0
} catch {
    Emit-Error $JobId 'INTERNAL' $_.Exception.Message $_.ScriptStackTrace
    exit 1
} finally {
    if ($graphics) { $graphics.Dispose() }
    if ($workBitmap) { $workBitmap.Dispose() }
    if ($srcImage) { $srcImage.Dispose() }
}
