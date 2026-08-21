chcp 65001 > $null
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
& node 'node_modules/typescript/bin/tsc' --noEmit -p tsconfig.json
Write-Output "EXITCODE=$LASTEXITCODE"
