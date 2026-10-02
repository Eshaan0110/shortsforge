# Downloads a portable ffmpeg (ffmpeg.exe + ffprobe.exe) into .tools\ffmpeg\bin.
# Used by start.bat when ffmpeg is missing and winget isn't available. No admin rights needed.
param(
    [string[]]$Urls = @(
        'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
        'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
    )
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # the progress bar makes Invoke-WebRequest many times slower
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root '.tools\ffmpeg\bin'
$zip = Join-Path $env:TEMP 'shortsforge-ffmpeg.zip'
$unpacked = Join-Path $env:TEMP 'shortsforge-ffmpeg'

foreach ($url in $Urls) {
    try {
        Write-Host "      Downloading ffmpeg (about 100 MB) from $url ..."
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            # Built into Windows 10/11: shows a progress bar and handles modern TLS better than PowerShell 5.1.
            & curl.exe -fL --retry 2 -# -o $zip $url
            if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit code $LASTEXITCODE)" }
        }
        else {
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        }
        if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $unpacked -Force

        $ffmpeg = Get-ChildItem $unpacked -Recurse -Filter ffmpeg.exe | Select-Object -First 1
        if (-not $ffmpeg -or -not (Test-Path (Join-Path $ffmpeg.DirectoryName 'ffprobe.exe'))) {
            throw 'the download did not contain ffmpeg.exe and ffprobe.exe'
        }
        New-Item -ItemType Directory -Force $dest | Out-Null
        Copy-Item (Join-Path $ffmpeg.DirectoryName '*.exe') $dest -Force
        Write-Host "      ffmpeg is ready in $dest"
        exit 0
    }
    catch {
        Write-Host "      That didn't work ($($_.Exception.Message)). Trying the next source ..."
    }
    finally {
        Remove-Item $zip, $unpacked -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Host '      Could not download ffmpeg.'
exit 1
