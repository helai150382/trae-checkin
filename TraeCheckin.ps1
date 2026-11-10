$Node = (Get-Command node).Source
$Script = Join-Path $env:USERPROFILE '.trae-checkin\trae-checkin.mjs'
$LogDir = Join-Path $env:USERPROFILE '.trae-checkin\logs'
$LogFile = Join-Path $LogDir 'task.log'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
& $Node $Script run *>> $LogFile
