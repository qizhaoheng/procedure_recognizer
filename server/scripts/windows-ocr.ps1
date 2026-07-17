param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath,
  [string]$LanguageTag = 'zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]

function Await-WinRT($Operation, [Type]$ResultType) {
  $task = $script:AsTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

$resolvedPath = (Resolve-Path -LiteralPath $ImagePath).Path
$storageFileType = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$file = Await-WinRT ($storageFileType::GetFileFromPathAsync($resolvedPath)) $storageFileType
$accessMode = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]::Read
$streamType = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$stream = Await-WinRT ($file.OpenAsync($accessMode)) $streamType
$decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$decoder = Await-WinRT ($decoderType::CreateAsync($stream)) $decoderType
$bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) $bitmapType
$language = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]::new($LanguageTag)
$ocrEngineType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$engine = $ocrEngineType::TryCreateFromLanguage($language)
if ($null -eq $engine) {
  $available = @($ocrEngineType::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  throw "OCR language '$LanguageTag' is unavailable. Installed OCR languages: $($available -join ', ')"
}
$resultType = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$result = Await-WinRT ($engine.RecognizeAsync($bitmap)) $resultType
$lines = @($result.Lines | ForEach-Object {
  $line = $_
  [pscustomobject]@{
    text = $line.Text
    words = @($line.Words | ForEach-Object {
      [pscustomobject]@{
        text = $_.Text
        x = [math]::Round($_.BoundingRect.X, 2)
        y = [math]::Round($_.BoundingRect.Y, 2)
        width = [math]::Round($_.BoundingRect.Width, 2)
        height = [math]::Round($_.BoundingRect.Height, 2)
      }
    })
  }
})

[pscustomobject]@{
  language = $engine.RecognizerLanguage.LanguageTag
  width = $bitmap.PixelWidth
  height = $bitmap.PixelHeight
  text = $result.Text
  lines = $lines
} | ConvertTo-Json -Depth 8 -Compress

$stream.Dispose()
$bitmap.Dispose()
