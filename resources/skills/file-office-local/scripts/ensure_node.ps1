<#
ensure_node.ps1 — mc-material-query 技能 Node.js 运行时自举脚本

逻辑:
  1. 检查 $NodeDir\node.exe 是否存在且版本 >= 要求版本（已有更新版本也算满足）→ 直接返回路径，跳过下载
  2. 不存在（或版本过低/损坏）→ 从腾讯云镜像下载 zip（失败自动换阿里云镜像）→ 解压到 $NodeDir → 返回路径
  3. 后续所有查询一律调用返回的 node.exe 路径

用法:
  $NODE = & .\ensure_node.ps1
  & $NODE <script.js> [args...]

可选参数:
  -NodeDir          node.exe 安装目录，默认 $env:USERPROFILE\.qwenworkcn\binaries\node\versions\22.22.2
  -RequiredVersion  要求的最低 Node 版本，默认 22.22.2
#>
param(
    [string]$NodeDir = (Join-Path $env:USERPROFILE '.qwenworkcn\binaries\node\versions\22.22.2'),
    [Version]$RequiredVersion = [Version]'22.22.2'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$NodeExe = Join-Path $NodeDir 'node.exe'
$ZipName = "node-v$RequiredVersion-win-x64.zip"
$Urls = @(
    "https://mirrors.cloud.tencent.com/nodejs-release/v$RequiredVersion/$ZipName",  # 首选：腾讯云镜像
    "https://registry.npmmirror.com/-/binary/node/v$RequiredVersion/$ZipName"       # 备选：阿里云镜像
)

function Log([string]$msg) { Write-Host "[ensure_node] $msg" }

# ── 1. 检查是否已存在（存在且版本 >= 要求版本 → 跳过；更新版本同样跳过）──
if (Test-Path $NodeExe) {
    try {
        $cur = [Version]((& $NodeExe --version) -replace '^v', '')
        if ($cur -ge $RequiredVersion) {
            Log "node.exe 已存在且版本满足 (v$cur >= v$RequiredVersion)，跳过下载: $NodeExe"
            return $NodeExe
        }
        Log "现有版本 v$cur 低于要求 v$RequiredVersion，准备下载"
    } catch {
        Log "现有 node.exe 无法执行，准备重新下载"
    }
}

# ── 2. 下载 zip（首选腾讯云镜像，失败自动换阿里云镜像）──
New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
$zipPath = Join-Path $env:TEMP $ZipName
$downloaded = $false
foreach ($url in $Urls) {
    try {
        Log "下载中: $url"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
        Log ("下载完成，大小 {0:N1} MB" -f ((Get-Item $zipPath).Length / 1MB))
        $downloaded = $true
        break
    } catch {
        Log ("下载失败: {0}" -f $_.Exception.Message)
    }
}
if (-not $downloaded) { throw "[ensure_node] 所有镜像均下载失败，请检查网络" }

# ── 3. 解压到 $NodeDir（剥掉外层 node-vX-win-x64 目录，使 $NodeDir\node.exe 直接可用）──
$extractTmp = Join-Path $env:TEMP ("node_extract_" + [guid]::NewGuid().ToString('N'))
Expand-Archive -Path $zipPath -DestinationPath $extractTmp -Force
$inner = Get-ChildItem $extractTmp -Directory | Select-Object -First 1
Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $NodeDir -Recurse -Force
Remove-Item $extractTmp -Recurse -Force
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

# ── 4. 验证并返回路径 ──
$ver = (& $NodeExe --version) -replace '^v', ''
Log "安装成功: v$ver -> $NodeExe"
return $NodeExe
