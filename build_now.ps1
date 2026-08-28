<#
.SYNOPSIS
  一键打包 MC物料查询 安装包。

.DESCRIPTION
  在本脚本所在目录（项目根）执行打包，等价于
  electron-vite build + electron-builder。
  默认打 Windows 包（NSIS 安装包 + 便携版）。

.PARAMETER Publish
  打包后直接发布到 GitHub Releases。需提前设置环境变量 GH_TOKEN。
  注意：electron-builder 创建的是 draft Release，
  需到 GitHub 手动改为 Published，否则客户端检测不到更新。

.PARAMETER Mac
  打包 macOS DMG（建议在 macOS 上执行）。

.PARAMETER All
  打包全平台。

.PARAMETER NoClean
  保留旧的 dist/ 目录，不清理。

.EXAMPLE
  .\build_now.ps1

.EXAMPLE
  $env:GH_TOKEN = 'xxx'; .\build_now.ps1 -Publish
#>
[CmdletBinding()]
param(
    [switch]$Publish,
    [switch]$Mac,
    [switch]$All,
    [switch]$NoClean
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 切到脚本所在目录（项目根），与调用位置无关
Set-Location -LiteralPath $PSScriptRoot
Write-Output "PROJECT: $PWD"

# 校验项目根
if (-not (Test-Path -LiteralPath (Join-Path $PWD 'package.json'))) {
    throw "未在项目根目录找到 package.json，当前目录：$PWD"
}

if ($Mac -and $All) {
    throw '-Mac 与 -All 不能同时使用'
}

# 依赖检查
if (-not (Test-Path -LiteralPath (Join-Path $PWD 'node_modules'))) {
    Write-Output 'node_modules 不存在，先执行 npm install ...'
    & npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
}

# 清理旧产物，避免 dist 里混入上一版本的安装包
$distDir = Join-Path $PWD 'dist'
if (-not $NoClean) {
    if (Test-Path -LiteralPath $distDir) {
        Write-Output "清理旧产物：$distDir"
        Remove-Item -LiteralPath $distDir -Recurse -Force
    }
}

# 选择 npm script
$script = if ($All) { 'pack:all' } elseif ($Mac) { 'pack:mac' } else { 'pack:win' }

Write-Output "RUN: npm run $script"
& npm run $script
if ($LASTEXITCODE -ne 0) {
    throw "打包失败，npm 退出码：$LASTEXITCODE"
}

# 列出产物
if (Test-Path -LiteralPath $distDir) {
    Write-Output ''
    Write-Output ('产物目录 ' + $distDir)
    Get-ChildItem -LiteralPath $distDir -File -Recurse |
        Sort-Object FullName |
        ForEach-Object {
            $size = '{0:N2} MB' -f ($_.Length / 1MB)
            $rel  = $_.FullName.Substring($distDir.Length + 1)
            Write-Output ('  ' + $rel + '  [' + $size + ']')
        }
}

# 可选：发布到 GitHub Releases
if ($Publish) {
    if (-not $env:GH_TOKEN) {
        throw '未检测到环境变量 GH_TOKEN，请先执行 $env:GH_TOKEN = token'
    }
    Write-Output ''
    Write-Output 'PUBLISH: electron-builder --publish=always'
    & npx electron-builder --win --config electron-builder.yml --publish=always
    if ($LASTEXITCODE -ne 0) { throw '发布失败' }
    Write-Output ''
    Write-Output '提示：electron-builder 创建的是 draft Release，请到 GitHub 改为 Published，否则客户端检测不到更新。'
}

Write-Output ''
Write-Output 'DONE'
