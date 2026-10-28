$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$taskId = [Guid]::NewGuid().ToString('N')
$buildRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot "calendar-planner-build-$taskId"))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot "calendar-planner-artifacts-$taskId"))

foreach ($path in @($buildRoot, $artifactRoot)) {
  if (-not $path.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '构建目录必须位于 Windows 临时目录内'
  }
}

function Remove-OwnedBuildFiles($LiteralPath) {
  if (-not (Test-Path -LiteralPath $LiteralPath)) { return }

  $resolved = (Resolve-Path -LiteralPath $LiteralPath).ProviderPath

  if ($resolved -ne $buildRoot -and $resolved -ne $artifactRoot) {
    throw '仅清理本次创建的构建目录'
  }

  $files = [IO.Directory]::EnumerateFiles($resolved, '*', [IO.SearchOption]::AllDirectories)

  foreach ($file in $files) {
    Remove-Item -LiteralPath $file -Force
  }

  $directories = [IO.Directory]::EnumerateDirectories($resolved, '*', [IO.SearchOption]::AllDirectories)
  $ordered = $directories | Sort-Object -Property Length -Descending

  foreach ($directory in $ordered) {
    Remove-Item -LiteralPath $directory
  }

  Remove-Item -LiteralPath $resolved
}

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe'))) {
  throw '未找到 Rust 工具链，请先安装 rustup stable-x86_64-pc-windows-msvc'
}
$env:Path = "$cargoBin;$env:Path"
$env:CARGO_NET_OFFLINE = 'true'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
  throw '未找到 Visual Studio Installer，无法加载 Windows C++ 编译环境'
}
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) {
  $fallbackVsPath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools'
  $fallbackCompiler = Get-ChildItem -Path (Join-Path $fallbackVsPath 'VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe') -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($fallbackCompiler) {
    $vsPath = $fallbackVsPath
  }
}
if (-not $vsPath) {
  throw '未找到 Visual Studio C++ Build Tools 工作负载'
}
$devShell = Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Set-Location -LiteralPath $tempRoot
Import-Module $devShell
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null

$sourceItems = @('index.html', 'assets', 'public', 'src', 'themes', 'package.json', 'package-lock.json', 'vite.config.js')
$tauriItems = @('capabilities', 'icons', 'src', 'build.rs', 'Cargo.lock', 'Cargo.toml', 'tauri.conf.json')
$succeeded = $false

try {
  New-Item -ItemType Directory -Path $buildRoot | Out-Null

  foreach ($item in $sourceItems) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $buildRoot -Recurse
  }
  $tauriRoot = Join-Path $buildRoot 'src-tauri'
  New-Item -ItemType Directory -Path $tauriRoot | Out-Null
  foreach ($item in $tauriItems) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "src-tauri\$item") -Destination $tauriRoot -Recurse
  }

  Push-Location $buildRoot
  try {
    npm ci --offline --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw 'npm ci 执行失败'
    }

    $tauri = Join-Path $buildRoot 'node_modules\.bin\tauri.cmd'
    if (-not (Test-Path -LiteralPath $tauri)) {
      throw '未找到本地 Tauri CLI'
    }
    & $tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
      throw 'Tauri Windows 绿色版构建失败'
    }
  }
  finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Path $artifactRoot | Out-Null

  $version = (Get-Content -LiteralPath (Join-Path $buildRoot 'package.json') -Raw | ConvertFrom-Json).version
  $archiveName = "calendar-planner-$version-windows-x64"
  $portableRoot = Join-Path $artifactRoot 'desktop-calendar-todo'
  New-Item -ItemType Directory -Path $portableRoot | Out-Null

  $executable = Join-Path $buildRoot 'src-tauri\target\release\桌面日历.exe'
  if (-not (Test-Path -LiteralPath $executable)) {
    throw '未找到桌面日历绿色版可执行文件'
  }
  Copy-Item -LiteralPath $executable -Destination (Join-Path $portableRoot '桌面日历.exe') -Force
  $lunarLicense = Join-Path $buildRoot 'src\vendor\lunar.LICENSE'
  Copy-Item -LiteralPath $lunarLicense -Destination (Join-Path $portableRoot 'lunar.LICENSE')
  @('双平台日历绿色版', '直接运行 桌面日历.exe。', 'calendar-planner.db 保存在当前目录，不自动读取旧项目数据库。') | Set-Content -LiteralPath (Join-Path $portableRoot '使用说明.txt') -Encoding UTF8

  $archive = Join-Path $artifactRoot "$archiveName.zip"
  Compress-Archive -LiteralPath $portableRoot -DestinationPath $archive -CompressionLevel Optimal
  $succeeded = $true
  Write-Host "ARTIFACT_ROOT=$artifactRoot"
}
finally {
  Remove-OwnedBuildFiles $buildRoot

  if (-not $succeeded) { Remove-OwnedBuildFiles $artifactRoot }
}
