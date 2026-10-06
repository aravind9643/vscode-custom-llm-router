$Action = New-ScheduledTaskAction -Execute "node.exe" -Argument "d:\VSCodeCustomEndpointModels\generate-models.js --fast --apply" -WorkingDirectory "d:\VSCodeCustomEndpointModels"
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "VSCodeCustomModelsSync" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Periodic synchronization of FreeLLMAPI and OmniRoute models for VS Code Insiders" -Force
Write-Host "✅ Scheduled Task 'VSCodeCustomModelsSync' successfully installed! Runs every 1 hour in background."
