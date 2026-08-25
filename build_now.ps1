$p = Get-ChildItem -Path 'E:\工具' -Directory -Filter 'MC物料查询插件' | Select-Object -ExpandProperty FullName
Write-Output "FOUND:$p"
$app = Join-Path $p 'desktop-app'
Write-Output "APP:$app"
Set-Location $app
npm run pack:win
