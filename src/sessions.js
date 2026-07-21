const crypto = require('crypto');

const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function issueSession({ roomCode, participantId, socketId, name }) {
  revokeParticipantSessions(roomCode, participantId);

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  sessions.set(tokenHash, {
    roomCode,
    participantId,
    socketId,
    name,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  return { token, tokenHash };
}

function getSession(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 100) return null;

  const tokenHash = hashToken(token);
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash);
    return null;
  }

  return { tokenHash, session };
}

function bindSession(tokenHash, socketId) {
  const session = sessions.get(tokenHash);
  if (session) session.socketId = socketId;
}

function revokeSession(tokenHash) {
  sessions.delete(tokenHash);
}

function revokeParticipantSessions(roomCode, participantId) {
  for (const [tokenHash, session] of sessions) {
    if (session.roomCode === roomCode && session.participantId === participantId) sessions.delete(tokenHash);
  }
}

function revokeRoomSessions(roomCode) {
  for (const [tokenHash, session] of sessions) {
    if (session.roomCode === roomCode) sessions.delete(tokenHash);
  }
}

function cleanupSessions() {
  const now = Date.now();
  for (const [tokenHash, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(tokenHash);
  }
}

function resetSessions() {
  sessions.clear();
}

setInterval(cleanupSessions, 60 * 1000).unref();

module.exports = {
  bindSession,
  getSession,
  issueSession,
  revokeParticipantSessions,
  revokeRoomSessions,
  revokeSession,
  resetSessions,
};
