Unregister-ScheduledTask -TaskName "VSCodeCustomModelsSync" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "✅ Scheduled Task 'VSCodeCustomModelsSync' removed."
