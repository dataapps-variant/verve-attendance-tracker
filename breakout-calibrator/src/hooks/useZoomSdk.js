import { useState, useEffect, useCallback } from 'react';
import zoomSdk from '@zoom/appssdk';

// Only request capabilities that are registered in Zoom Marketplace
const CAPABILITIES = [
  'getBreakoutRoomList',
  'getMeetingParticipants',
  'assignParticipantToBreakoutRoom',
  'changeBreakoutRoom',
  'getMeetingContext',
  'getMeetingUUID',
  'getUserContext'
];

export function useZoomSdk() {
  const [isConfigured, setIsConfigured] = useState(false);
  const [error, setError] = useState(null);
  const [meetingContext, setMeetingContext] = useState(null);
  const [userContext, setUserContext] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [roleCheckCount, setRoleCheckCount] = useState(0);

  // Initialize SDK
  useEffect(() => {
    async function initializeSdk() {
      try {
        console.log('Initializing Zoom SDK...');

        // Configure the SDK - use installed version 0.16.x
        const configResponse = await zoomSdk.config({
          capabilities: CAPABILITIES
        });

        console.log('Zoom SDK configured:', configResponse);
        setIsConfigured(true);

        // Get meeting context
        try {
          const meeting = await zoomSdk.getMeetingContext();
          setMeetingContext(meeting);
          console.log('Meeting context:', meeting);
        } catch (e) {
          console.log('Could not get meeting context:', e.message);
        }

        // Get user context to check if host
        try {
          const user = await zoomSdk.getUserContext();
          setUserContext(user);

          // Debug: log ALL user fields to see what Zoom returns
          console.log('=== USER CONTEXT DEBUG ===');
          console.log('Full user object:', JSON.stringify(user, null, 2));
          console.log('user.role:', user.role);
          console.log('user.userRole:', user.userRole);
          console.log('user.status:', user.status);
          console.log('user.participantRole:', user.participantRole);

          // Check for various role formats and fields
          const role = String(user.role || user.userRole || user.participantRole || '').toLowerCase();
          const isHostOrCohost =
            role === 'host' ||
            role === 'cohost' ||
            role === 'co-host' ||
            role === 'coHost' ||
            role.includes('host') ||  // catch any variation
            user.role === 1 ||  // some SDKs use numeric
            user.role === 2 ||
            user.userRole === 1 ||
            user.userRole === 2;

          setIsHost(isHostOrCohost);
          console.log('Detected role:', role, '-> isHost:', isHostOrCohost);
        } catch (e) {
          console.log('Could not get user context:', e.message);
          // If we can't get user context, try to proceed anyway (will fail on SDK calls if not host)
          setIsHost(true);  // Optimistically allow, SDK will reject if no permission
          console.log('Setting isHost=true optimistically');
        }

      } catch (err) {
        console.error('Failed to initialize Zoom SDK:', err);
        setError(err.message || 'Failed to initialize Zoom SDK');
      }
    }

    initializeSdk();
  }, []);

  // Get all breakout rooms with names
  const getBreakoutRooms = useCallback(async () => {
    if (!isConfigured) {
      throw new Error('SDK not configured');
    }

    try {
      console.log('Calling getBreakoutRoomList...');
      const response = await zoomSdk.getBreakoutRoomList();
      console.log('Breakout rooms response:', JSON.stringify(response));
      const rooms = response.rooms || response.breakoutRooms || [];
      console.log('Found', rooms.length, 'rooms');
      return rooms;
    } catch (err) {
      console.error('Failed to get breakout rooms:', err);
      console.error('Error details:', JSON.stringify(err));
      throw err;
    }
  }, [isConfigured]);

  // Get all meeting participants
  const getParticipants = useCallback(async () => {
    if (!isConfigured) {
      throw new Error('SDK not configured');
    }

    try {
      const response = await zoomSdk.getMeetingParticipants();
      console.log('Participants:', response);
      return response.participants || [];
    } catch (err) {
      console.error('Failed to get participants:', err);
      throw err;
    }
  }, [isConfigured]);

  // Move a participant to a breakout room
  const moveParticipantToRoom = useCallback(async (participantUUID, roomUUID) => {
    if (!isConfigured) {
      throw new Error('SDK not configured');
    }

    try {
      // Try with curly braces first (per forum guidance), then without
      const withBraces = roomUUID?.includes('{') ? roomUUID : `{${roomUUID}}`;
      const withoutBraces = roomUUID ? roomUUID.replace(/[{}]/g, '') : roomUUID;

      console.log('=== CALLING assignParticipantToBreakoutRoom ===');
      console.log('participantUUID:', participantUUID);
      console.log('roomUUID with braces:', withBraces);
      console.log('roomUUID without braces:', withoutBraces);

      // Try WITH curly braces first
      try {
        const params1 = { participantUUID, uuid: withBraces };
        console.log('Attempt 1 - with braces:', JSON.stringify(params1));
        const response = await zoomSdk.assignParticipantToBreakoutRoom(params1);
        console.log('SUCCESS with braces! Response:', JSON.stringify(response));
        return { ...response, _debug: { participantUUID, uuid: withBraces }, success: true };
      } catch (err1) {
        console.log('Failed with braces:', err1?.message);

        // Try WITHOUT curly braces
        try {
          const params2 = { participantUUID, uuid: withoutBraces };
          console.log('Attempt 2 - without braces:', JSON.stringify(params2));
          const response = await zoomSdk.assignParticipantToBreakoutRoom(params2);
          console.log('SUCCESS without braces! Response:', JSON.stringify(response));
          return { ...response, _debug: { participantUUID, uuid: withoutBraces }, success: true };
        } catch (err2) {
          console.error('=== BOTH ATTEMPTS FAILED ===');
          console.error('Error 1 (with braces):', err1?.message);
          console.error('Error 2 (without braces):', err2?.message);
          throw err2;
        }
      }
    } catch (err) {
      console.error('Failed to move participant:', err);
      throw err;
    }
  }, [isConfigured]);

  // Change YOUR OWN breakout room (use when you ARE the bot)
  const changeMyBreakoutRoom = useCallback(async (roomUUID) => {
    if (!isConfigured) {
      throw new Error('SDK not configured');
    }

    const cleanRoomUUID = roomUUID ? roomUUID.replace(/[{}]/g, '') : roomUUID;

    try {
      console.log('=== CALLING changeBreakoutRoom (moving SELF) ===');
      console.log('uuid:', cleanRoomUUID);

      const response = await zoomSdk.changeBreakoutRoom({ uuid: cleanRoomUUID });

      console.log('=== changeBreakoutRoom RESPONSE ===');
      console.log('Response:', JSON.stringify(response));
      return { ...response, success: true };
    } catch (err) {
      console.error('changeBreakoutRoom failed:', err);
      throw err;
    }
  }, [isConfigured]);

  // Move participant back to main room
  const moveToMainRoom = useCallback(async (participantUUID) => {
    if (!isConfigured) {
      throw new Error('SDK not configured');
    }

    try {
      // For main room, only pass participantUUID (no breakoutRoomUUID)
      const params = { participantUUID };
      console.log('Moving participant to main room:', participantUUID);
      const response = await zoomSdk.assignParticipantToBreakoutRoom(params);
      console.log('Move to main room response:', response);
      return response;
    } catch (err) {
      console.error('Failed to move to main room:', err);
      throw err;
    }
  }, [isConfigured]);

  // Get meeting UUID
  const getMeetingUUID = useCallback(async () => {
    if (!isConfigured) {
      throw new Error('SDK not configured');
    }

    try {
      const response = await zoomSdk.getMeetingUUID();
      return response.meetingUUID;
    } catch (err) {
      console.error('Failed to get meeting UUID:', err);
      throw err;
    }
  }, [isConfigured]);

  // Refresh user role - can be called manually to re-check host status
  const refreshUserRole = useCallback(async () => {
    try {
      console.log('=== REFRESHING USER ROLE ===');
      const user = await zoomSdk.getUserContext();
      setUserContext(user);
      setRoleCheckCount(prev => prev + 1);

      console.log('Refresh - Full user object:', JSON.stringify(user, null, 2));

      const role = String(user.role || user.userRole || user.participantRole || '').toLowerCase();
      const isHostOrCohost =
        role === 'host' ||
        role === 'cohost' ||
        role === 'co-host' ||
        role === 'coHost' ||
        role.includes('host') ||
        user.role === 1 ||
        user.role === 2 ||
        user.userRole === 1 ||
        user.userRole === 2;

      setIsHost(isHostOrCohost);
      console.log('Refresh - Detected role:', role, '-> isHost:', isHostOrCohost);
      return { role, isHost: isHostOrCohost, user };
    } catch (e) {
      console.error('Failed to refresh user role:', e);
      return { error: e.message };
    }
  }, []);

  // Force host mode - bypass role check (use when SDK returns wrong role)
  const forceHostMode = useCallback(() => {
    console.log('=== FORCING HOST MODE ===');
    setIsHost(true);
  }, []);

  return {
    isConfigured,
    error,
    meetingContext,
    userContext,
    isHost,
    roleCheckCount,
    getBreakoutRooms,
    getParticipants,
    moveParticipantToRoom,
    moveToMainRoom,
    getMeetingUUID,
    changeMyBreakoutRoom,  // For moving yourself
    refreshUserRole,  // Re-check role
    forceHostMode  // Bypass role check
  };
}

export default useZoomSdk;
