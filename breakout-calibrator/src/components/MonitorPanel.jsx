import React, { useState, useCallback, useEffect, useRef } from 'react';
import useZoomSdk from '../hooks/useZoomSdk';
import axios from 'axios';

const POLL_INTERVAL_MS = 30000; // 30 seconds

const getBackendUrl = () => {
  if (process.env.REACT_APP_BACKEND_URL) return process.env.REACT_APP_BACKEND_URL;
  if (process.env.NODE_ENV === 'production') return '';
  return 'http://localhost:8080';
};

const api = axios.create({
  baseURL: getBackendUrl(),
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
});

function getParticipantName(p) {
  return p.screenName || p.displayName || p.participantName || p.name || p.userName || p.user_name || '';
}

function getParticipantEmail(p) {
  return p.email || p.participantEmail || p.user_email || '';
}

// Extract meeting ID from context (handles different SDK versions/formats)
function extractMeetingId(context) {
  if (!context) return '';
  // Try various field names Zoom SDK might use
  return String(context.meetingID || context.meetingId || context.mid || context.meeting_id || '');
}

function MonitorPanel() {
  const {
    isConfigured,
    error: sdkError,
    meetingContext,
    userContext,
    isHost,
    getBreakoutRooms,
    getParticipants,
    getMeetingUUID,
    refreshUserRole,
    forceHostMode
  } = useZoomSdk();

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [autoStarted, setAutoStarted] = useState(false);
  const [lastPoll, setLastPoll] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const [roomCount, setRoomCount] = useState(0);
  const [participantCount, setParticipantCount] = useState(0);
  const [errors, setErrors] = useState([]);
  const [logs, setLogs] = useState([]);
  const [roomSummary, setRoomSummary] = useState([]);

  const intervalRef = useRef(null);
  const meetingIdRef = useRef(null);

  const addLog = useCallback((msg) => {
    const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    setLogs(prev => [...prev.slice(-50), `[${time}] ${msg}`]);
  }, []);

  // Single poll: get all rooms + participants, send to backend
  const doPoll = useCallback(async () => {
    try {
      // Get breakout rooms (for room names and UUIDs)
      const rooms = await getBreakoutRooms();
      if (!rooms || rooms.length === 0) {
        addLog('No breakout rooms found');
        return;
      }

      // Build room UUID -> name mapping
      const roomMap = {};
      rooms.forEach(room => {
        const uuid = room.breakoutRoomUUID || room.uuid || room.id || '';
        const name = room.breakoutRoomName || room.name || 'Unknown';
        if (uuid) roomMap[uuid] = name;
      });

      // Get all participants (includes their current room)
      let allParticipants = [];
      try {
        allParticipants = await getParticipants();
        addLog(`Got ${allParticipants.length} participants from SDK`);
      } catch (pErr) {
        addLog(`getMeetingParticipants failed: ${pErr.message}`);
        // Fall back to room.participants if available
      }

      // Build snapshot data - try both approaches
      const roomData = [];

      // Approach 1: Use participants with breakoutRoomUUID
      if (allParticipants.length > 0) {
        // Group participants by their breakout room
        const participantsByRoom = {};
        allParticipants.forEach(p => {
          const roomUUID = p.breakoutRoomUUID || p.boRoomUUID || '';
          const pName = getParticipantName(p);
          const pEmail = getParticipantEmail(p);

          // Skip Scout Bot
          if (pName.toLowerCase().includes('scout') && pName.toLowerCase().includes('bot')) {
            return;
          }

          if (roomUUID && roomMap[roomUUID]) {
            if (!participantsByRoom[roomUUID]) {
              participantsByRoom[roomUUID] = { room_name: roomMap[roomUUID], participants: [] };
            }
            participantsByRoom[roomUUID].participants.push({
              name: pName,
              email: pEmail,
              uuid: p.participantUUID || p.uuid || p.id || ''
            });
          }
        });

        Object.values(participantsByRoom).forEach(room => {
          if (room.participants.length > 0) {
            roomData.push(room);
          }
        });
      }

      // Approach 2: Fall back to room.participants if no participants from getMeetingParticipants
      if (roomData.length === 0) {
        rooms.forEach(room => {
          const roomName = room.breakoutRoomName || room.name || 'Unknown';
          const participants = (room.participants || room.members || room.attendees || []).map(p => ({
            name: getParticipantName(p),
            email: getParticipantEmail(p),
            uuid: p.participantUUID || p.uuid || p.id || ''
          })).filter(p => p.name && !p.name.toLowerCase().includes('scout bot'));

          if (participants.length > 0) {
            roomData.push({ room_name: roomName, participants });
          }
        });
      }

      const totalParticipants = roomData.reduce((sum, r) => sum + r.participants.length, 0);

      // Send to backend
      const meetingId = meetingIdRef.current || extractMeetingId(meetingContext);
      const response = await api.post('/monitor/snapshot', {
        meeting_id: meetingId,
        rooms: roomData
      });

      if (response.data.success) {
        setPollCount(prev => prev + 1);
        setRoomCount(rooms.length);
        setParticipantCount(totalParticipants);
        setLastPoll(new Date());
        setRoomSummary(roomData.map(r => ({
          name: r.room_name,
          count: r.participants.length
        })));
        addLog(`OK: ${roomData.length} rooms, ${totalParticipants} participants`);
      } else {
        addLog(`ERROR: ${response.data.error}`);
        setErrors(prev => [...prev.slice(-10), response.data.error]);
      }
    } catch (err) {
      addLog(`POLL FAILED: ${err.message}`);
      setErrors(prev => [...prev.slice(-10), err.message]);
    }
  }, [getBreakoutRooms, getParticipants, meetingContext, addLog]);

  // Start monitoring
  const startMonitoring = useCallback(async () => {
    if (isMonitoring) return;

    try {
      const uuid = await getMeetingUUID();

      // Try multiple sources for meeting ID
      let mid = extractMeetingId(meetingContext);

      // Debug: log the full context to see what fields are available
      addLog(`Meeting context: ${JSON.stringify(meetingContext)}`);

      // Fallback: try to get meeting ID from getMeetingUUID response (some SDK versions include it)
      if (!mid && uuid) {
        // Some SDK versions return meeting ID as part of UUID or as separate field
        // Also try extracting numeric part if UUID contains meeting ID
        const numericMatch = uuid.match(/^(\d{9,11})/);
        if (numericMatch) {
          mid = numericMatch[1];
          addLog(`Extracted meeting ID from UUID: ${mid}`);
        }
      }

      // Last resort: Use the configured meeting ID (from env or hardcoded)
      if (!mid) {
        mid = process.env.REACT_APP_MEETING_ID || '9034027764';  // Fallback to known meeting ID
        addLog(`Using fallback meeting ID: ${mid}`);
      }

      meetingIdRef.current = mid;

      if (!meetingIdRef.current) {
        addLog('ERROR: Could not get meeting ID from any source');
        setErrors(prev => [...prev, 'Meeting ID not available - check SDK permissions']);
        return;
      }

      addLog(`Starting monitor for meeting ${meetingIdRef.current}`);
      addLog(`Meeting UUID: ${uuid}`);

      setIsMonitoring(true);
      setErrors([]);

      // First poll immediately
      await doPoll();

      // Then poll every 30 seconds
      intervalRef.current = setInterval(doPoll, POLL_INTERVAL_MS);
      addLog(`Polling every ${POLL_INTERVAL_MS / 1000}s`);
    } catch (err) {
      addLog(`Failed to start: ${err.message}`);
    }
  }, [isMonitoring, getMeetingUUID, meetingContext, doPoll, addLog]);

  // Stop monitoring
  const stopMonitoring = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsMonitoring(false);
    addLog('Monitoring stopped');
  }, [addLog]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // AUTO-RETRY: If not host, try refreshing role a few times
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    if (isConfigured && !isHost && retryCount < 3) {
      const timer = setTimeout(async () => {
        console.log(`Auto-retry role check ${retryCount + 1}/3`);
        await refreshUserRole();
        setRetryCount(prev => prev + 1);
      }, 2000);  // Retry every 2 seconds
      return () => clearTimeout(timer);
    }
  }, [isConfigured, isHost, retryCount, refreshUserRole]);

  // AUTO-START: Begin monitoring as soon as SDK is ready and user is host/co-host
  useEffect(() => {
    if (isConfigured && isHost && !isMonitoring && !autoStarted) {
      setAutoStarted(true);
      addLog('Auto-starting monitor (host/co-host detected)');
      setTimeout(() => startMonitoring(), 2000);
    }
  }, [isConfigured, isHost, isMonitoring, autoStarted, startMonitoring, addLog]);

  // Not configured
  if (!isConfigured) {
    return (
      <div style={styles.container}>
        <h2 style={styles.title}>Room Monitor</h2>
        <div style={styles.idleBox}>
          <div style={styles.statusRow}>
            <span style={styles.statusDot('#FFB800')} />
            <span style={styles.statusText}>{sdkError || 'Connecting to Zoom...'}</span>
          </div>
        </div>
      </div>
    );
  }

  // Not host - show debug info and retry options
  if (!isHost) {
    const detectedRole = userContext?.role || userContext?.userRole || 'unknown';
    return (
      <div style={styles.container}>
        <h2 style={styles.title}>Room Monitor</h2>
        <div style={styles.errorBox}>
          <p style={styles.errorText}>Requires host or co-host role</p>
          <p style={{ color: '#888', fontSize: '10px', margin: '8px 0' }}>
            Detected role: "{String(detectedRole)}"
          </p>
          <p style={{ color: '#666', fontSize: '9px', margin: '4px 0' }}>
            User context: {JSON.stringify(userContext || {}).substring(0, 100)}...
          </p>
        </div>
        <div style={styles.actions}>
          <button
            style={styles.startButton}
            onClick={async () => {
              const result = await refreshUserRole();
              console.log('Role refresh result:', result);
            }}
          >
            Refresh Role
          </button>
          <button
            style={{ ...styles.stopButton, backgroundColor: '#FF9800' }}
            onClick={() => {
              forceHostMode();
            }}
          >
            Force Start
          </button>
        </div>
        <p style={{ color: '#666', fontSize: '9px', textAlign: 'center' }}>
          If you ARE a co-host, click "Force Start" to bypass this check
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Room Monitor</h2>
      {meetingContext && (
        <span style={styles.meetingId}>Meeting: {meetingContext.meetingID}</span>
      )}

      {/* Status */}
      <div style={isMonitoring ? styles.activeBox : styles.idleBox}>
        <div style={styles.statusRow}>
          <span style={styles.statusDot(isMonitoring ? '#00C851' : '#888')} />
          <span style={styles.statusLabel}>
            {isMonitoring ? 'MONITORING' : 'IDLE'}
          </span>
        </div>

        {isMonitoring && (
          <div style={styles.statsGrid}>
            <div style={styles.stat}>
              <span style={styles.statValue}>{pollCount}</span>
              <span style={styles.statLabel}>Polls</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statValue}>{roomCount}</span>
              <span style={styles.statLabel}>Rooms</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statValue}>{participantCount}</span>
              <span style={styles.statLabel}>In Rooms</span>
            </div>
          </div>
        )}

        {lastPoll && (
          <p style={styles.lastPoll}>
            Last poll: {lastPoll.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </p>
        )}
      </div>

      {/* Controls */}
      <div style={styles.actions}>
        {!isMonitoring ? (
          <button style={styles.startButton} onClick={startMonitoring}>
            Start Monitoring
          </button>
        ) : (
          <button style={styles.stopButton} onClick={stopMonitoring}>
            Stop Monitoring
          </button>
        )}
      </div>

      {/* Occupied Rooms */}
      {roomSummary.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>
            OCCUPIED ROOMS ({roomSummary.length})
          </h3>
          <div style={styles.roomGrid}>
            {roomSummary.sort((a, b) => b.count - a.count).map((room, i) => (
              <div key={i} style={styles.roomItem}>
                <span style={styles.roomName}>{room.name}</span>
                <span style={styles.roomCount}>{room.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div style={styles.errorBox}>
          <h3 style={styles.sectionTitle}>ERRORS ({errors.length})</h3>
          {errors.slice(-3).map((e, i) => (
            <p key={i} style={styles.errorText}>{e}</p>
          ))}
        </div>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>LOG</h3>
          <pre style={styles.logBox}>{logs.slice(-15).join('\n')}</pre>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', maxWidth: '500px', margin: '0 auto', minHeight: '100vh', backgroundColor: '#1a1a2e' },
  title: { color: '#fff', fontSize: '18px', fontWeight: '600', margin: 0 },
  meetingId: { color: '#666', fontSize: '11px' },

  activeBox: { backgroundColor: 'rgba(0,200,81,0.08)', border: '1px solid rgba(0,200,81,0.3)', borderRadius: '10px', padding: '16px' },
  idleBox: { backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid #333', borderRadius: '10px', padding: '16px' },
  statusRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' },
  statusDot: (color) => ({ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: color, boxShadow: `0 0 6px ${color}` }),
  statusLabel: { color: '#fff', fontSize: '14px', fontWeight: '600', letterSpacing: '1px' },
  statusText: { color: '#ccc', fontSize: '13px' },
  lastPoll: { color: '#888', fontSize: '11px', margin: '8px 0 0 0' },

  statsGrid: { display: 'flex', gap: '16px' },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  statValue: { color: '#fff', fontSize: '24px', fontWeight: '700' },
  statLabel: { color: '#888', fontSize: '10px', textTransform: 'uppercase' },

  actions: { display: 'flex', gap: '8px' },
  startButton: { flex: 1, padding: '12px', backgroundColor: '#00C851', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },
  stopButton: { flex: 1, padding: '12px', backgroundColor: '#ff4757', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },

  section: { display: 'flex', flexDirection: 'column', gap: '6px' },
  sectionTitle: { color: '#888', fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', margin: 0 },
  roomGrid: { display: 'flex', flexDirection: 'column', gap: '2px' },
  roomItem: { display: 'flex', justifyContent: 'space-between', padding: '6px 10px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px' },
  roomName: { color: '#2D8CFF', fontSize: '12px' },
  roomCount: { color: '#fff', fontSize: '12px', fontWeight: '600' },

  errorBox: { backgroundColor: 'rgba(255,71,87,0.1)', border: '1px solid rgba(255,71,87,0.3)', borderRadius: '8px', padding: '10px' },
  errorText: { color: '#ff6b6b', fontSize: '11px', margin: '4px 0' },

  logBox: { backgroundColor: 'rgba(0,0,0,0.4)', padding: '10px', borderRadius: '6px', fontSize: '10px', color: '#00C851', overflow: 'auto', maxHeight: '150px', fontFamily: 'Monaco, monospace', margin: 0, whiteSpace: 'pre-wrap' }
};

export default MonitorPanel;
