# Registra la tarea «WhatsApp lector»: arranca el lector al iniciar sesión en Windows,
# sin ventana, y lo reinicia si se cae. Se corre una vez:
#   pwsh -File C:\dev\wip\whatsapp-lector\scripts\instalar-tarea.ps1
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

# conhost --headless corre el proceso de consola sin abrir ninguna ventana.
$accion = New-ScheduledTaskAction `
  -Execute "$env:windir\System32\conhost.exe" `
  -Argument "--headless `"$node`" `"$raiz\src\vincular.js`"" `
  -WorkingDirectory $raiz

$disparador = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$ajustes = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'WhatsApp lector' -Action $accion -Trigger $disparador `
  -Settings $ajustes -Principal $principal `
  -Description 'Lector local y de solo lectura de WhatsApp (C:\dev\wip\whatsapp-lector).' -Force | Out-Null

"Tarea «WhatsApp lector» registrada. Arranca sola al iniciar sesión."
