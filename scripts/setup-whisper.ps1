#Requires -Version 5.1
# Downloads the latest whisper.cpp Windows x64 CPU build + ggml-base.en.bin.
# Idempotent: skips anything already present.
#
# Usage:
#   setup-whisper.ps1                         # install into <repo>/bin/whisper  (dev checkout)
#   setup-whisper.ps1 -InstallDir <path>      # install into <path>/bin/whisper  (npx / runtime)

param(
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($InstallDir) {
  $root = $InstallDir
} else {
  $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$binDir = Join-Path $root 'bin\whisper'
$modelsDir = Join-Path $binDir 'models'

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

$cliPath = Join-Path $binDir 'whisper-cli.exe'
$modelPath = Join-Path $modelsDir 'ggml-base.en.bin'

# --- 1. whisper.cpp binary ---------------------------------------------------
if (-not (Test-Path $cliPath)) {
  Write-Host '[setup-whisper] fetching latest whisper.cpp release metadata...'
  $release = Invoke-RestMethod 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest' `
    -Headers @{ 'User-Agent' = 'murmur-setup' }

  $asset = $release.assets `
    | Where-Object { $_.name -like 'whisper-bin-x64*' `
        -and $_.name -notlike '*blas*' `
        -and $_.name -notlike '*cublas*' } `
    | Select-Object -First 1
  if (-not $asset) {
    throw "No plain whisper-bin-x64 asset in release $($release.tag_name). Check https://github.com/ggerganov/whisper.cpp/releases manually."
  }

  $sizeMb = [math]::Round($asset.size / 1MB, 1)
  Write-Host "[setup-whisper] downloading $($asset.name) ($sizeMb MB)..."
  $zipPath = Join-Path $env:TEMP 'murmur-whisper.zip'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing

  Write-Host '[setup-whisper] extracting...'
  Expand-Archive -Path $zipPath -DestinationPath $binDir -Force
  Remove-Item $zipPath -Force

  # Recent whisper.cpp releases nest binaries inside a Release\ subfolder.
  # Flatten so the .exe and DLLs sit at $binDir, matching the default config.
  if (-not (Test-Path $cliPath)) {
    $nested = Get-ChildItem -Path $binDir -Directory -ErrorAction SilentlyContinue `
      | Where-Object { Test-Path (Join-Path $_.FullName 'whisper-cli.exe') } `
      | Select-Object -First 1
    if ($nested) {
      Write-Host "[setup-whisper] flattening $($nested.Name)\ -> bin\whisper\"
      Get-ChildItem -Path $nested.FullName -Force | ForEach-Object {
        Move-Item -Path $_.FullName -Destination $binDir -Force
      }
      Remove-Item -Path $nested.FullName -Recurse -Force
    }
  }

  if (-not (Test-Path $cliPath)) {
    throw 'Extracted archive does not contain whisper-cli.exe. Archive layout may have changed.'
  }
  Write-Host "[setup-whisper] whisper-cli.exe ready at $cliPath"
} else {
  Write-Host "[setup-whisper] binary already present at $cliPath"
}

# --- 2. ggml-base.en.bin -----------------------------------------------------
if (-not (Test-Path $modelPath)) {
  Write-Host '[setup-whisper] downloading ggml-base.en.bin (~148 MB)...'
  $modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'
  Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath -UseBasicParsing
  Write-Host "[setup-whisper] model ready at $modelPath"
} else {
  Write-Host "[setup-whisper] model already present at $modelPath"
}

# --- 3. Print env lines ------------------------------------------------------
Write-Host ''
Write-Host '============================================================'
Write-Host ' Done. Confirm these lines are in your .env:'
Write-Host '============================================================'
Write-Host "WHISPER_CLI_PATH=$cliPath"
Write-Host "WHISPER_MODEL_PATH=$modelPath"
Write-Host '============================================================'
