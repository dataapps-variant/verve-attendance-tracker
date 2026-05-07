"""
DAILY ATTENDANCE REPORT GENERATOR
=================================
Generates CSV report with ONE ROW PER PARTICIPANT
All times in IST (Indian Standard Time)

Format:
- Name, Email, Main Join IST, Main Left IST, Total Duration
- Room History: RoomName [Joined: HH:MM | Left: HH:MM | Duration: Xmin] -> NextRoom [...]

Triggered by Cloud Scheduler daily or /generate-report endpoint

ACCURACY ENHANCEMENT:
- Uses FIXED_ROOM_SEQUENCE as authoritative source for room names
- Cross-references room_index from calibration with fixed sequence
- Validates and corrects room names using multiple mapping sources
"""

from google.cloud import bigquery
from datetime import datetime, timedelta
import os
import csv
import io
import json

# ==============================================================================
# FIXED ROOM SEQUENCE - AUTHORITATIVE ROOM ORDER
# This MUST match the FIXED_ROOM_SEQUENCE in app.py
# Used for cross-referencing and correcting room names by index
# ==============================================================================
FIXED_ROOM_SEQUENCE = [
    # Floor 1 rooms (1.1 to 1.34)
    "1.1:It's Accrual World",
    "1.2:Between The Spreadsheet",
    "1.3:Opera House",
    "1.4:Statue Of Liberty",
    "1.5:The Squad",
    "1.6:Visionary Vault - Team Kruta",
    "1.7:Inspiration Island - Team Kruta",
    "1.8:Life In The Math Lane",
    "1.9:Finance Pirates",
    "1.10:Number Nook - Team Ganesh",
    "1.11:Accountaholics",
    "1.12:The Forbidden City",
    "1.13:Dev's Professional Bungalow",
    "1.14:Innovation Station",
    "1.15:Precision Point",
    "1.16:Creative Corner - Team Dev",
    "1.17:Insight Lounge - Team Dev",
    "1.18:Synergy Space - Team Dev",
    "1.19:Numbers and Nuance",
    "1.20:Sales Wizard",
    "1.21:Sales Station",
    "1.22:Virtual Vista",
    "1.23:The Genius Lounge",
    "1.24:Emirates Palace",
    "1.25:Victoria Memorial",
    "1.26:Number Nexus",
    "1.27:Ledger Lounge",
    "1.28:The Capital Corner",
    "1.29:Meeting Room - Hawks Eye",
    "1.30:HR Connect Room",
    "1.31:HR Strategy Meeting Suite",
    "1.32:Interview Room - 1",
    "1.33:Interview Room - 2",
    "1.34:Interview/Meeting - Eagle Eyes",
    # Floor 2 (Vridam)
    "2.0:Vridam - Wellness Meeting Lounge",
    # Floor 3 rooms (Cloud/Accurest)
    "3.1:Cloud Gunners",
    "3.2:Cloud Knights",
    "3.3:Cloud Avengers",
    "3.4:Cloud Falcons",
    "3.5:Cloud Titans",
    "3.6:Cloud Guardians",
    "3.7:Inspiration Lounge /Meeting Room",
    "3.8:Agenda Chamber/Meeting Room",
    "3.9:ABAP AMS",
    # Floor 4 rooms (KPRC)
    "4.1:KPRC - Legal Eagle",
    "4.2:KPRC - Corporate Crest",
    "4.3:KPRC - Innovation Lounge",
    "4.4:KPRC - Decision Dome",
    "4.5:KPRC - Focus Zone",
    "4.6:KPRC - Strategic Space",
    # Floor 5 rooms (Accurest)
    "5.1:Accurest - HR Oasis",
    "5.2:Accurest-Meeting Room:Strategist",
    "5.3:Accurest - Meeting Room: Pioneer",
    "5.4:Accurest - Automation Crafters",
    "5.5:Accurest-Learning / Meeting room",
    "5.6:Accurest - Sales Lounge",
    "5.7:Accurest - Focus Lab",
    "5.8:Accurest - Pattern Inbound",
    "5.9:Accurest - Pattern Planning",
    "5.10:Accurest - Himal's Suite",
    "5.11:Accurest Insight : Team Shubham",
    "5.12:Accurest - Creators",
    "5.13:Accurest - Interview Room",
    # Special zones
    "6.0:Silence Zone",
    "7.0:Masti Ki Pathshala",
    "8.0:BREAK TIME - Tea/Lunch/ Dinner",
]

# Build reverse lookup: room_name -> room_index
ROOM_NAME_TO_INDEX = {name: idx for idx, name in enumerate(FIXED_ROOM_SEQUENCE)}

# ==============================================================================
# IST TIMEZONE HELPERS (UTC+5:30 - India Standard Time)
# ==============================================================================
IST_OFFSET = timedelta(hours=5, minutes=30)

def get_ist_now():
    """Get current datetime in IST"""
    return datetime.utcnow() + IST_OFFSET

def get_ist_date():
    """Get current date in IST (YYYY-MM-DD)"""
    return get_ist_now().strftime('%Y-%m-%d')

def get_yesterday_ist():
    """Get yesterday's date in IST"""
    return (get_ist_now() - timedelta(days=1)).strftime('%Y-%m-%d')

# SendGrid for email
try:
    from sendgrid import SendGridAPIClient
    from sendgrid.helpers.mail import Mail, Attachment, FileContent, FileName, FileType, Disposition
    import base64
    SENDGRID_AVAILABLE = True
except ImportError:
    SENDGRID_AVAILABLE = False
    print("[ReportGenerator] SendGrid not installed - email disabled")

# Configuration
GCP_PROJECT_ID = os.environ.get('GCP_PROJECT_ID', 'verve-attendance-tracker')
BQ_DATASET = os.environ.get('BQ_DATASET', 'breakout_room_calibrator')
SENDGRID_API_KEY = os.environ.get('SENDGRID_API_KEY', '')
REPORT_EMAIL_FROM = os.environ.get('REPORT_EMAIL_FROM', 'reports@verveadvisory.com')
REPORT_EMAIL_TO = os.environ.get('REPORT_EMAIL_TO', '')


def get_bq_client():
    """Get BigQuery client"""
    return bigquery.Client(project=GCP_PROJECT_ID)


def generate_daily_report(report_date=None):
    """
    Generate daily attendance report with ONE ROW PER PARTICIPANT
    All times in IST (UTC + 5:30)

    MONITOR MODE: Room history is built from SDK polling snapshots (room_snapshots table).
    Main room join/leave still comes from webhooks (participant_events table).

    Args:
        report_date: Date string 'YYYY-MM-DD' (defaults to yesterday)

    Returns:
        Dictionary with report data and CSV content
    """
    if report_date is None:
        report_date = get_yesterday_ist()

    import re
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', report_date):
        raise ValueError(f"Invalid date format: {report_date}. Expected YYYY-MM-DD")

    try:
        datetime.strptime(report_date, '%Y-%m-%d')
    except ValueError:
        raise ValueError(f"Invalid date: {report_date}")

    print(f"[Report] Generating report for {report_date} (IST) using SDK snapshots")

    client = get_bq_client()

    # =============================================
    # MAIN QUERY - ONE ROW PER PARTICIPANT
    #
    # Each row = one participant's daily attendance summary.
    # Shows: Name, Email, Main Join/Left, Total Duration, Room History
    #
    # How it works:
    #   SDK polls every 30s → detect room transitions → output each visit
    # =============================================

    main_query = f"""
    WITH
    -- ==========================================================
    -- IDENTITY BRIDGE: Every (UUID, name) pair that appeared in
    -- SDK snapshots today. Lets us link webhook events (which
    -- carry only name) to the stable UUID even when a participant
    -- renamed themselves mid-meeting (e.g. "Shashank" -> "Shashank-1").
    -- ==========================================================
    participant_name_map AS (
      SELECT DISTINCT
        COALESCE(
          NULLIF(participant_uuid, ''),
          NULLIF(LOWER(TRIM(participant_email)), ''),
          LOWER(TRIM(participant_name))
        ) as participant_key,
        LOWER(TRIM(participant_name)) as name_key,
        NULLIF(LOWER(TRIM(participant_email)), '') as email_key
      FROM `{GCP_PROJECT_ID}.{BQ_DATASET}.room_snapshots`
      WHERE event_date = '{report_date}'
        AND participant_name IS NOT NULL AND participant_name != ''
    ),
    -- Separate lookups to avoid OR-join cartesian products
    name_to_key AS (
      SELECT name_key, ANY_VALUE(participant_key) as participant_key
      FROM participant_name_map
      GROUP BY name_key
    ),
    email_to_key AS (
      SELECT email_key, ANY_VALUE(participant_key) as participant_key
      FROM participant_name_map
      WHERE email_key IS NOT NULL
      GROUP BY email_key
    ),
    -- ==========================================================
    -- WEBHOOK DATA: Main meeting join/leave times
    -- Grouped by participant_key (UUID via name bridge) so that
    -- renamed participants collapse into a single join/leave row.
    -- Webhook names that never appear in snapshots fall back to
    -- their own name as the key (preserves old behavior for them).
    -- ==========================================================
    webhook_times AS (
      SELECT
        COALESCE(etk.participant_key, ntk.participant_key, LOWER(TRIM(pe.participant_name))) as participant_key,
        MAX(pe.participant_email) as participant_email,
        MIN(CASE WHEN pe.event_type = 'participant_joined' THEN TIMESTAMP(pe.event_timestamp) END) as main_join_time,
        MAX(CASE WHEN pe.event_type = 'participant_left' THEN TIMESTAMP(pe.event_timestamp) END) as main_leave_time
      FROM `{GCP_PROJECT_ID}.{BQ_DATASET}.participant_events` pe
      LEFT JOIN email_to_key etk
        ON NULLIF(LOWER(TRIM(pe.participant_email)), '') = etk.email_key
      LEFT JOIN name_to_key ntk
        ON LOWER(TRIM(pe.participant_name)) = ntk.name_key
      WHERE pe.event_date = '{report_date}'
        AND pe.participant_name IS NOT NULL AND pe.participant_name != ''
      GROUP BY COALESCE(etk.participant_key, ntk.participant_key, LOWER(TRIM(pe.participant_name)))
    ),
    -- ==========================================================
    -- STEP 1: Clean snapshots - remove empty room names, and dedupe
    -- cases where a participant briefly appeared in two rooms at the
    -- same snapshot_time (SDK transition artifact). Prefer breakout
    -- rooms over Main Room so the visit timeline stays coherent.
    -- ==========================================================
    snapshot_clean AS (
      SELECT
        COALESCE(
          NULLIF(participant_uuid, ''),
          NULLIF(LOWER(TRIM(participant_email)), ''),
          LOWER(TRIM(participant_name))
        ) as participant_key,
        participant_name,
        COALESCE(NULLIF(participant_email, ''), '') as participant_email,
        room_name,
        snapshot_time
      FROM `{GCP_PROJECT_ID}.{BQ_DATASET}.room_snapshots`
      WHERE event_date = '{report_date}'
        AND participant_name IS NOT NULL AND participant_name != ''
        AND room_name IS NOT NULL AND room_name != ''
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY COALESCE(
          NULLIF(participant_uuid, ''),
          NULLIF(LOWER(TRIM(participant_email)), ''),
          LOWER(TRIM(participant_name))
        ),
                     snapshot_time
        ORDER BY
          CASE WHEN LOWER(room_name) = 'main room' OR LOWER(room_name) LIKE '0.main%' THEN 1 ELSE 0 END,
          room_name
      ) = 1
    ),
    -- ==========================================================
    -- STEP 2: Detect room transitions AND time gaps
    -- A new visit starts when:
    --   1. Room changes, OR
    --   2. Time gap > 5 minutes (person left and rejoined)
    -- ==========================================================
    snapshot_transitions AS (
      SELECT *,
        LAG(room_name) OVER (
          PARTITION BY participant_key
          ORDER BY snapshot_time
        ) as prev_room,
        LAG(snapshot_time) OVER (
          PARTITION BY participant_key
          ORDER BY snapshot_time
        ) as prev_snapshot_time
      FROM snapshot_clean
    ),
    visit_groups_raw AS (
      SELECT *,
        SUM(CASE
          WHEN prev_room IS NULL OR room_name != prev_room THEN 1
          -- Also start new visit if time gap > 5 minutes (300 seconds)
          WHEN prev_snapshot_time IS NOT NULL
               AND TIMESTAMP_DIFF(snapshot_time, prev_snapshot_time, SECOND) > 300 THEN 1
          ELSE 0
        END) OVER (
          PARTITION BY participant_key
          ORDER BY snapshot_time
        ) as visit_id
      FROM snapshot_transitions
    ),
    -- ==========================================================
    -- STEP 3: Collapse into room visits, drop 0-minute entries
    -- ==========================================================
    room_visits_raw AS (
      SELECT
        participant_key,
        MAX(participant_name) as participant_name,
        MAX(participant_email) as participant_email,
        room_name,
        MIN(snapshot_time) as join_time,
        MAX(snapshot_time) as leave_time,
        -- Use interval-sum (not span) so gaps within a visit are handled correctly
        CEILING(SUM(
          CASE
            WHEN prev_snapshot_time IS NULL THEN 0
            WHEN TIMESTAMP_DIFF(snapshot_time, prev_snapshot_time, SECOND) <= 300 THEN
              TIMESTAMP_DIFF(snapshot_time, prev_snapshot_time, SECOND) / 60.0
            ELSE 0
          END
        )) as duration_mins
      FROM visit_groups_raw
      GROUP BY participant_key, room_name, visit_id
      HAVING COUNT(*) > 1  -- Need at least 2 snapshots for a meaningful visit
    ),
    -- ==========================================================
    -- STEP 4: Re-merge consecutive same-room visits
    -- After removing 0-min entries, "Room A → Room A" can happen
    -- e.g., Room A [10:00-10:30], (0-min removed), Room A [10:31-11:00]
    --   → should become Room A [10:00-11:00]
    -- ==========================================================
    remerge_transitions AS (
      SELECT *,
        LAG(room_name) OVER (
          PARTITION BY participant_key
          ORDER BY join_time
        ) as prev_room_name
      FROM room_visits_raw
    ),
    remerge_groups AS (
      SELECT *,
        SUM(CASE
          WHEN prev_room_name IS NULL OR room_name != prev_room_name THEN 1
          ELSE 0
        END) OVER (
          PARTITION BY participant_key
          ORDER BY join_time
        ) as merge_group
      FROM remerge_transitions
    ),
    room_visits_final AS (
      SELECT
        participant_key,
        MAX(participant_name) as participant_name,
        MAX(participant_email) as participant_email,
        room_name,
        MIN(join_time) as join_time,
        MAX(leave_time) as leave_time,
        FORMAT_TIMESTAMP('%H:%M', MIN(join_time), 'Asia/Kolkata') as room_joined_ist,
        FORMAT_TIMESTAMP('%H:%M', MAX(leave_time), 'Asia/Kolkata') as room_left_ist,
        -- Sum actual durations from room_visits_raw (already interval-based)
        SUM(duration_mins) as duration_mins
      FROM remerge_groups
      GROUP BY participant_key, room_name, merge_group
    ),
    participant_report AS (
      SELECT
        rv.participant_key,
        ARRAY_AGG(rv.participant_name ORDER BY rv.join_time DESC LIMIT 1)[OFFSET(0)] as Name,
        COALESCE(
          NULLIF(MAX(NULLIF(rv.participant_email, '')), ''),
          NULLIF(MAX(NULLIF(w.participant_email, '')), ''),
          ''
        ) as Email,
        MIN(rv.join_time) as first_room_join_time,
        MAX(rv.leave_time) as last_room_leave_time,
        MIN(w.main_join_time) as main_join_time,
        MAX(w.main_leave_time) as main_leave_time,
        SUM(CASE
          WHEN LOWER(rv.room_name) LIKE '%break time%' THEN 0
          ELSE rv.duration_mins
        END) as Total_Duration_Minutes,
        STRING_AGG(
          FORMAT(
            '%s [Joined: %s | Left: %s | Duration: %dmin]',
            rv.room_name,
            rv.room_joined_ist,
            rv.room_left_ist,
            CAST(rv.duration_mins AS INT64)
          ),
          ' -> '
          ORDER BY rv.join_time
        ) as Room_History
      FROM room_visits_final rv
      LEFT JOIN webhook_times w ON rv.participant_key = w.participant_key
      WHERE rv.participant_name NOT LIKE '%Scout%'
        AND rv.duration_mins > 0
      GROUP BY rv.participant_key
    )
    -- ==========================================================
    -- OUTPUT: One clean row per participant with summed time
    -- ==========================================================
    SELECT
      Name,
      Email,
      FORMAT_TIMESTAMP('%H:%M', COALESCE(main_join_time, first_room_join_time), 'Asia/Kolkata') as Main_Joined_IST,
      FORMAT_TIMESTAMP('%H:%M', COALESCE(main_leave_time, last_room_leave_time), 'Asia/Kolkata') as Main_Left_IST,
      Total_Duration_Minutes,
      Room_History
    FROM participant_report
    ORDER BY Name
    """

    try:
        results = list(client.query(main_query).result())
        print(f"[Report] Query returned {len(results)} participants")
    except Exception as e:
        print(f"[Report] Query error: {e}")
        results = []

    # =============================================
    # BUILD REPORT OBJECT
    # =============================================
    report = {
        'report_date': report_date,
        'generated_at': datetime.utcnow().isoformat(),
        'total_participants': len(results),
        'participants': [dict(row.items()) for row in results]
    }

    # Generate CSV
    report['csv_content'] = generate_csv(report)

    print(f"[Report] Generated report with {len(results)} participants")
    return report


def format_minutes_to_hhmm(minutes):
    """Format minutes as Xh Ym"""
    if not minutes or minutes <= 0:
        return '0m'
    try:
        minutes = int(minutes)
        hours = minutes // 60
        mins = minutes % 60
        if hours > 0:
            return f"{hours}h {mins}m"
        return f"{mins}m"
    except (ValueError, TypeError):
        return '0m'


def generate_csv(report):
    """Generate CSV content from report data - ONE ROW PER PARTICIPANT"""
    output = io.StringIO()
    writer = csv.writer(output)

    # Header - includes main meeting times from webhooks
    writer.writerow([
        'Name',
        'Email',
        'Main_Joined_IST',
        'Main_Left_IST',
        'Total_Duration_Minutes',
        'Total_Duration',
        'Room_History'
    ])

    # Data rows - one row per participant
    for p in report['participants']:
        duration_mins = p.get('Total_Duration_Minutes', 0) or 0

        writer.writerow([
            p.get('Name', '') or '',
            p.get('Email', '') or '',
            p.get('Main_Joined_IST', '') or '',
            p.get('Main_Left_IST', '') or '',
            duration_mins,
            format_minutes_to_hhmm(duration_mins),
            p.get('Room_History', '') or ''
        ])

    return output.getvalue()


def send_report_email(report, report_date):
    """Send report via SendGrid with CSV attachment"""
    if not SENDGRID_AVAILABLE:
        print("[Report] SendGrid not available")
        return False

    if not all([SENDGRID_API_KEY, REPORT_EMAIL_FROM, REPORT_EMAIL_TO]):
        print("[Report] Email configuration incomplete")
        print(f"  SENDGRID_API_KEY: {'set' if SENDGRID_API_KEY else 'NOT SET'}")
        print(f"  REPORT_EMAIL_FROM: {REPORT_EMAIL_FROM}")
        print(f"  REPORT_EMAIL_TO: {REPORT_EMAIL_TO}")
        return False

    try:
        # Build HTML email body
        html_content = f"""
        <html>
        <head>
            <style>
                body {{ font-family: Arial, sans-serif; margin: 20px; }}
                h1 {{ color: #2D8CFF; }}
                h2 {{ color: #333; border-bottom: 2px solid #2D8CFF; padding-bottom: 5px; }}
                table {{ border-collapse: collapse; width: 100%; margin: 20px 0; }}
                th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }}
                th {{ background-color: #2D8CFF; color: white; }}
                tr:nth-child(even) {{ background-color: #f9f9f9; }}
                .summary {{ background: #f0f8ff; padding: 15px; border-radius: 8px; margin: 20px 0; }}
                .footer {{ color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; }}
            </style>
        </head>
        <body>
            <h1>Daily Zoom Attendance Report</h1>
            <p><strong>Date:</strong> {report_date}</p>
            <p><strong>Generated:</strong> {report['generated_at']} UTC</p>
            <p><strong>All times shown in IST (Indian Standard Time)</strong></p>

            <div class="summary">
                <h2>Summary</h2>
                <p><strong>Total Participants:</strong> {report['total_participants']}</p>
            </div>

            <h2>Attendance (First 30 participants shown, full data in CSV)</h2>
            <table>
                <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Joined IST</th>
                    <th>Left IST</th>
                    <th>Total Duration</th>
                    <th>Room History</th>
                </tr>
        """

        for p in report['participants'][:30]:  # Limit to 30 in email
            room_history = p.get('Room_History', '-') or '-'
            duration = p.get('Total_Duration_Minutes', 0) or 0

            html_content += f"""
                <tr>
                    <td>{p.get('Name', '')}</td>
                    <td>{p.get('Email', '')}</td>
                    <td>{p.get('Main_Joined_IST', '')}</td>
                    <td>{p.get('Main_Left_IST', '')}</td>
                    <td>{format_minutes_to_hhmm(duration)}</td>
                    <td style="font-size:10px;">{room_history}</td>
                </tr>
            """

        html_content += """
            </table>

            <div class="footer">
                <p><strong>Full attendance data is in the attached CSV file.</strong></p>
                <p>CSV Format: One row per participant with summed room time</p>
                <p>Columns: Name, Email, Main_Joined_IST, Main_Left_IST, Total_Duration_Minutes, Total_Duration, Room_History</p>
                <p>Generated by Zoom Breakout Room Tracker</p>
            </div>
        </body>
        </html>
        """

        # Create email
        # Support both comma and semicolon as email delimiters
        to_emails = [e.strip() for e in REPORT_EMAIL_TO.replace(';', ',').split(',') if e.strip()]
        message = Mail(
            from_email=REPORT_EMAIL_FROM,
            to_emails=to_emails,
            subject=f"Daily Zoom Attendance Report - {report_date}",
            html_content=html_content
        )

        # Attach CSV
        csv_content = report['csv_content']
        encoded = base64.b64encode(csv_content.encode('utf-8')).decode()
        attachment = Attachment(
            FileContent(encoded),
            FileName(f"attendance_report_{report_date}.csv"),
            FileType('text/csv'),
            Disposition('attachment')
        )
        message.add_attachment(attachment)

        # Send
        sg = SendGridAPIClient(SENDGRID_API_KEY)
        response = sg.send(message)

        print(f"[Report] Email sent! Status: {response.status_code}")
        return True

    except Exception as e:
        print(f"[Report] Email error: {e}")
        import traceback
        traceback.print_exc()
        return False


def save_csv_to_gcs(report, report_date, bucket_name):
    """Save CSV file to Google Cloud Storage"""
    from google.cloud import storage

    try:
        client = storage.Client()
        bucket = client.bucket(bucket_name)

        blob_path = f"reports/attendance_report_{report_date}.csv"
        blob = bucket.blob(blob_path)
        blob.upload_from_string(report['csv_content'], content_type='text/csv')

        print(f"[Report] Saved to GCS: gs://{bucket_name}/{blob_path}")
        return f"gs://{bucket_name}/{blob_path}"

    except Exception as e:
        print(f"[Report] GCS save error: {e}")
        return None


# Flask endpoint handler (called from app.py)
def generate_report_handler(report_date=None):
    """
    Handler for /generate-report endpoint
    Returns report data and optionally sends email
    """
    if report_date is None:
        # Default to yesterday in IST
        report_date = get_yesterday_ist()

    try:
        report = generate_daily_report(report_date)

        email_sent = False
        if SENDGRID_API_KEY and REPORT_EMAIL_TO:
            email_sent = send_report_email(report, report_date)

        return {
            'success': True,
            'date': report_date,
            'participants': report['total_participants'],
            'email_sent': email_sent,
            'email_to': REPORT_EMAIL_TO if email_sent else None
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e)
        }


if __name__ == '__main__':
    # Test report generation
    import sys

    if len(sys.argv) > 1:
        date = sys.argv[1]
    else:
        date = get_ist_date()  # Use IST date

    print(f"Generating report for {date}...")
    report = generate_daily_report(date)

    # Save CSV locally for testing
    filename = f"attendance_report_{date}.csv"
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        f.write(report['csv_content'])
    print(f"Saved: {filename}")

    print(f"\nReport generated with {report['total_participants']} participants")

    # Show first few rows
    print("\nFirst 5 participants:")
    for p in report['participants'][:5]:
        print(f"  {p.get('Name', '')} - {p.get('Main_Joined_IST', '')} to {p.get('Main_Left_IST', '')}")
