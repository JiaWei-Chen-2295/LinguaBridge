$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$gnuToolchain = "stable-x86_64-pc-windows-gnu"
$toolchainRoot = Join-Path $env:USERPROFILE ".rustup\toolchains\$gnuToolchain"
$selfContainedLib = Join-Path $toolchainRoot "lib\rustlib\x86_64-pc-windows-gnu\lib\self-contained"
$w64devkitBin = "C:\dev\w64devkit\bin"

if (-not (Test-Path $toolchainRoot)) {
  Write-Error "Rust toolchain '$gnuToolchain' is not installed. Run: rustup toolchain install $gnuToolchain"
}

if (-not (Test-Path $selfContainedLib)) {
  Write-Error "GNU Rust self-contained library path was not found: $selfContainedLib"
}

if (-not (Test-Path $w64devkitBin)) {
  Write-Error "w64devkit was not found at $w64devkitBin. Install it or update scripts/dev-desktop.ps1."
}

$env:RUSTUP_TOOLCHAIN = $gnuToolchain
$env:LIBRARY_PATH = $selfContainedLib
$env:RUSTFLAGS = "-L native=$selfContainedLib"
$env:PATH = "$w64devkitBin;$env:PATH"

Set-Location $workspaceRoot

Write-Host "==> Launching LinguaBridge desktop app via Tauri" -ForegroundColor Cyan
Write-Host "Rust toolchain: $gnuToolchain"
Write-Host "Using linker tools from: $w64devkitBin"

& npm run tauri:dev -w @lingua-bridge/desktop
exit $LASTEXITCODE
