const { closeRoom, rooms } = require('./rooms');
const { revokeRoomSessions } = require('./sessions');

function minutesToMilliseconds(value) {
  return value * 60 * 1000;
}

function getMinutesFromEnvironment(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function startRoomCleanup(io, { clearRoomTemporaryData = () => {} } = {}) {
  const roomTtlMs = minutesToMilliseconds(getMinutesFromEnvironment('ROOM_TTL_MINUTES', 360));
  const emptyRoomTtlMs = minutesToMilliseconds(getMinutesFromEnvironment('EMPTY_ROOM_TTL_MINUTES', 10));
  const intervalMs = minutesToMilliseconds(getMinutesFromEnvironment('ROOM_CLEANUP_INTERVAL_MINUTES', 5));

  function removeExpiredRooms() {
    const now = Date.now();

    for (const room of Array.from(rooms.values())) {
      const inactiveForMs = now - room.lastActivityAt;
      const emptyRoomExpired = room.participants.size === 0 && inactiveForMs >= emptyRoomTtlMs;
      const inactiveRoomExpired = inactiveForMs >= roomTtlMs;
      if (!emptyRoomExpired && !inactiveRoomExpired) continue;

      const message = emptyRoomExpired
        ? 'Пустая комната удалена по таймауту.'
        : 'Комната закрыта из-за длительной неактивности.';

      io.to(room.code).emit('room-closed', { message });
      revokeRoomSessions(room.code);
      clearRoomTemporaryData(room.code);
      closeRoom(room);
      io.in(room.code).disconnectSockets(true);
    }
  }

  const interval = setInterval(removeExpiredRooms, intervalMs);
  interval.unref?.();

  return {
    removeExpiredRooms,
    stop() {
      clearInterval(interval);
    },
  };
}

module.exports = { startRoomCleanup };
