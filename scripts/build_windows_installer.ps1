[CmdletBinding()]
param(
  [switch]$SkipFlutterBuild
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot 'build\windows\x64\runner\Release'
$releaseExe = Join-Path $releaseDir 'arus.exe'
$installerScript = Join-Path $projectRoot 'installer\Arus.iss'
$artifactsDir = Join-Path $projectRoot 'artifacts'

if (-not $SkipFlutterBuild) {
  $flutter = $null
  $flutterCommand = Get-Command flutter.bat -ErrorAction SilentlyContinue
  if ($null -ne $flutterCommand) {
    $flutter = $flutterCommand.Source
  }

  if ([string]::IsNullOrWhiteSpace($flutter)) {
    $flutterCandidates = @(
      'C:\Android\flutter\bin\flutter.bat',
      (Join-Path $env:LOCALAPPDATA 'Android\flutter\bin\flutter.bat')
    )
    foreach ($candidate in $flutterCandidates) {
      if (Test-Path -LiteralPath $candidate) {
        $flutter = $candidate
        break
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace($flutter)) {
    throw 'Flutter tidak ditemukan. Tambahkan flutter.bat ke PATH atau jalankan dengan -SkipFlutterBuild.'
  }

  Push-Location $projectRoot
  try {
    & $flutter build windows --release --no-pub
    if ($LASTEXITCODE -ne 0) {
      throw "Flutter release build gagal dengan exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $releaseExe)) {
  throw "Bundle release tidak ditemukan: $releaseExe"
}

$versionMatch = [regex]::Match(
  (Get-Content -LiteralPath (Join-Path $projectRoot 'pubspec.yaml') -Raw),
  '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+)'
)
$appVersion = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { '1.0.0' }

$iscc = $null
$isccCommand = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($null -ne $isccCommand) {
  $iscc = $isccCommand.Source
}

if ([string]::IsNullOrWhiteSpace($iscc)) {
  $isccCandidates = @(
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  foreach ($candidate in $isccCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      $iscc = $candidate
      break
    }
  }
}

if ([string]::IsNullOrWhiteSpace($iscc)) {
  throw 'Inno Setup 6 tidak ditemukan. Install Inno Setup, lalu jalankan ulang script ini.'
}

New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null
& $iscc "/DAppVersion=$appVersion" $installerScript
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup gagal dengan exit code $LASTEXITCODE."
}

$installerPath = Join-Path $artifactsDir "Arus-Setup-$appVersion.exe"
if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "Installer tidak ditemukan setelah proses packaging: $installerPath"
}

Write-Host "Installer berhasil dibuat: $installerPath"
