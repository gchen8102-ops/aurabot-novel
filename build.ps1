# 打包：只把「跑起来需要的文件」装进 zip，测试样书和备份一概不带
#
#   pwsh -File build.ps1            # 出 dist/aurabot-novel-<版本>.zip
#   pwsh -File build.ps1 -KeepStage # 同时留下解压前的目录，方便看装出来的样子
#
# 文件清单以 package.json 的 files 为准，改清单只改那里。

param([switch]$KeepStage)

# 控制台按 UTF-8 输出，中文提示不乱码（老版 Windows PowerShell 默认是 GBK）
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$version = $pkg.version

# index.mjs 和 package.json 的版本号必须一致，不然别人装上去面板显示的和包里写的不一样
$index = Get-Content (Join-Path $root 'index.mjs') -Raw -Encoding utf8
$m = [regex]::Match($index, "version:\s*'([^']+)'")
if (-not $m.Success) { throw 'index.mjs 里找不到 version' }
if ($m.Groups[1].Value -ne $version) {
  throw "版本号对不上：index.mjs 是 $($m.Groups[1].Value)，package.json 是 $version"
}

$dist = Join-Path $root 'dist'
$stageRoot = Join-Path $dist 'stage'
$stage = Join-Path $stageRoot 'novel'   # zip 里要有一层 novel/，解压到 modules 下就是 modules\novel
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$copied = @()
foreach ($f in $pkg.files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { throw "package.json 里列的文件不存在：$f" }
  $dst = Join-Path $stage $f
  $dir = Split-Path $dst -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item $src $dst -Force
  $copied += $f
}

$zip = Join-Path $dist "aurabot-novel-$version.zip"
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -Force

$size = (Get-Item $zip).Length
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash

Write-Host ''
Write-Host "打好了：$zip"
Write-Host ("大小：{0:N1} KB" -f ($size / 1KB))
Write-Host "SHA256：$hash"
Write-Host ''
Write-Host '包里的文件：'
foreach ($f in $copied) {
  $len = (Get-Item (Join-Path $stage $f)).Length
  Write-Host ("  {0,-16} {1,8} B" -f $f, $len)
}

# 安全检查：包里不能出现样书、测试数据、备份、令牌
$bad = $copied | Where-Object { $_ -match '(?i)(1\.txt|\.plain\.txt|\.testdata|\.tmpfmt|\.bak|\.tmpfmt)' }
if ($bad) { throw "包里混进了不该发布的东西：$($bad -join ', ')" }

if (-not $KeepStage) { Remove-Item $stageRoot -Recurse -Force }
