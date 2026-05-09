# ============================================
# SCOUT BOT VM SETUP SCRIPT
# Run this in PowerShell as Administrator
# ============================================

Write-Host "=== Scout Bot VM Setup ===" -ForegroundColor Cyan

# 1. Create ScoutBot directory
Write-Host "`n[1/6] Creating C:\ScoutBot directory..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path "C:\ScoutBot" -Force | Out-Null
Write-Host "Done!" -ForegroundColor Green

# 2. Create join_meeting.bat and watchdog launcher
Write-Host "`n[2/6] Creating join_meeting.bat and watchdog launcher..." -ForegroundColor Yellow
$meetingId = Read-Host "Enter your Zoom Meeting ID (numbers only)"
$meetingPwd = Read-Host "Enter your Zoom Meeting Password"

$batContent = @"
@echo off
:: Wait 60 seconds for Zoom to fully start
timeout /t 60 /nobreak
:: Open the recurring meeting join link
start zoommtg://zoom.us/join?confno=$meetingId&pwd=$meetingPwd
"@

$batContent | Out-File -FilePath "C:\ScoutBot\join_meeting.bat" -Encoding ASCII
Write-Host "Created C:\ScoutBot\join_meeting.bat" -ForegroundColor Green

$watchdogScript = Join-Path $PSScriptRoot "scout_bot_watchdog.ps1"
if (Test-Path $watchdogScript) {
    Copy-Item $watchdogScript "C:\ScoutBot\scout_bot_watchdog.ps1" -Force
}

$watchdogLauncher = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ScoutBot\scout_bot_watchdog.ps1" -MeetingId "$meetingId" -MeetingPwd "$meetingPwd"
"@

$watchdogLauncher | Out-File -FilePath "C:\ScoutBot\start_watchdog.bat" -Encoding ASCII
Write-Host "Created C:\ScoutBot\start_watchdog.bat" -ForegroundColor Green

# 3. Create scheduled tasks
Write-Host "`n[3/6] Creating scheduled tasks..." -ForegroundColor Yellow
schtasks /create /tn "ScoutBot-JoinMeeting" /tr "C:\ScoutBot\join_meeting.bat" /sc daily /st 09:55 /f
schtasks /create /tn "ScoutBot-ZoomWatchdog" /tr "C:\ScoutBot\start_watchdog.bat" /sc onlogon /f
Write-Host "Scheduled tasks created!" -ForegroundColor Green

# 4. Configure auto-login
Write-Host "`n[4/6] Configuring auto-login..." -ForegroundColor Yellow
$username = "dataapps"
$password = 'nhhjayUY4~w.hR<'

reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 1 /f | Out-Null
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultUserName /t REG_SZ /d $username /f | Out-Null
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword /t REG_SZ /d $password /f | Out-Null
Write-Host "Auto-login configured!" -ForegroundColor Green

# 5. Prevent sleep and screen lock
Write-Host "`n[5/6] Disabling sleep and screen lock..." -ForegroundColor Yellow
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "Sleep disabled!" -ForegroundColor Green

# 6. Download Zoom
Write-Host "`n[6/6] Opening Zoom download page..." -ForegroundColor Yellow
Start-Process "https://zoom.us/download"
Write-Host "Download and install Zoom Desktop Client manually" -ForegroundColor Yellow
Write-Host "Then log in as Scout Bot account" -ForegroundColor Yellow
Write-Host "Settings > General > Check 'Start Zoom when I start Windows'" -ForegroundColor Yellow

Write-Host "`n=== Setup Complete ===" -ForegroundColor Cyan
Write-Host @"

MANUAL STEPS REMAINING:
1. Install Zoom from the browser that just opened
2. Log in to Zoom as Scout Bot
3. Zoom Settings > General > Enable 'Start Zoom when I start Windows'
4. In Zoom Marketplace app settings, enable 'Enable the app when a meeting starts'
5. Reboot the VM to test auto-login

The VM will auto-join your meeting every day at 9:55 AM IST.
The watchdog will also run at login and reopen the meeting if Zoom closes.
"@ -ForegroundColor White
