# ============================================
# Scout Bot Zoom Watchdog
# Keeps the Zoom desktop client/meeting open on the VM.
# ============================================

param(
  [string]$MeetingId = $env:SCOUTBOT_MEETING_ID,
  [string]$MeetingPwd = $env:SCOUTBOT_MEETING_PWD,
  [int]$CheckIntervalSeconds = 120
)

if (-not $MeetingId) {
  Write-Error "Missing meeting ID. Pass -MeetingId or set SCOUTBOT_MEETING_ID."
  exit 1
}

$meetingUrl = "zoommtg://zoom.us/join?confno=$MeetingId"
if ($MeetingPwd) {
  $meetingUrl = "$meetingUrl&pwd=$MeetingPwd"
}

Write-Host "Scout Bot watchdog started for meeting $MeetingId"
Write-Host "Checking Zoom every $CheckIntervalSeconds seconds."

while ($true) {
  $zoom = Get-Process -Name "Zoom" -ErrorAction SilentlyContinue

  if (-not $zoom) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$stamp] Zoom is not running. Opening meeting..."
    Start-Process $meetingUrl
    Start-Sleep -Seconds 60
  }

  Start-Sleep -Seconds $CheckIntervalSeconds
}
