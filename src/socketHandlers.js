const bcrypt = require('bcrypt');
const {
  addParticipant, addSystemMessage, addUserMessage, assignNextOwner, clearHistory,
  closeRoom, createRoom, getRoom, getRoomSnapshot, isPrivateRoom, removeParticipant, rooms,
} = require('./rooms');
const { joinLimiter, messageLimiter, resumeLimiter, roomCreationLimiter, typingLimiter, webRtcSignalLimiter } = require('./limits');
const { getWebRtcConfiguration } = require('./turnCredentials');
const { bindSession, getSession, issueSession, revokeRoomSessions, revokeSession } = require('./sessions');
const { asObject, PRIVATE_TRANSPORT_MODES, TRANSPORT_MODES, validateCreateRoom, validateJoinRoom, validateMaxParticipants, validateMessage } = require('./validation');

function readPositiveInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const MAX_FAILED_PIN_ATTEMPTS = readPositiveInteger('PIN_ATTEMPT_LIMIT', 5, { min: 1, max: 20 });
const PIN_BLOCK_MS = readPositiveInteger('PIN_BLOCK_MINUTES', 5, { min: 1, max: 60 }) * 60_000;
const MAX_ACTIVE_ROOMS = readPositiveInteger('MAX_ACTIVE_ROOMS', 1000, { min: 1, max: 10_000 });
const pinAttempts = new Map();
const pendingDeliveries = new Map();

function getClientAddress(socket) {
  const realIp = socket.handshake.headers['x-real-ip'];
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) return forwardedFor.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

function safeLog(event, details = {}) { console.warn('[echo]', JSON.stringify({ event, ...details })); }

function on(socket, event, handler) {
  socket.on(event, (...args) => Promise.resolve(handler(...args)).catch((error) => {
    safeLog('socket-handler-failed', { event, errorName: error?.name || 'Error' });
    socket.emit(event === 'create-room' ? 'room-error' : 'chat-error', { action: event, message: 'Не удалось обработать запрос. Попробуйте ещё раз.' });
  }));
}

function getAttemptKey(socket, roomCode) { return `${getClientAddress(socket)}:${roomCode}`; }

function getPinAttemptState(key) {
  const state = pinAttempts.get(key);
  const now = Date.now();
  if (!state || now - state.lastFailedAt > PIN_BLOCK_MS) { pinAttempts.delete(key); return null; }
  if (state.blockedUntil && state.blockedUntil <= now) { pinAttempts.delete(key); return null; }
  return state;
}

function recordFailedPinAttempt(key) {
  const previous = getPinAttemptState(key);
  const now = Date.now();
  const count = (previous?.count || 0) + 1;
  const state = { count, lastFailedAt: now, blockedUntil: count >= MAX_FAILED_PIN_ATTEMPTS ? now + PIN_BLOCK_MS : null };
  pinAttempts.set(key, state);
  return state;
}

function clearPinAttemptsForRoom(roomCode) {
  const suffix = `:${roomCode}`;
  for (const key of pinAttempts.keys()) if (key.endsWith(suffix)) pinAttempts.delete(key);
}

function cleanupTemporaryState() {
  const now = Date.now();
  for (const [key, state] of pinAttempts) if (now - state.lastFailedAt > PIN_BLOCK_MS || (state.blockedUntil && state.blockedUntil <= now)) pinAttempts.delete(key);
  for (const [messageId, state] of pendingDeliveries) if (state.expiresAt <= now || state.recipientSocketIds.size === 0) pendingDeliveries.delete(messageId);
}
setInterval(cleanupTemporaryState, 60_000).unref();

function resetSocketState() { pinAttempts.clear(); pendingDeliveries.clear(); }
function isNameTaken(room, name) { return Array.from(room.participants.values()).some((p) => p.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru')); }
function findParticipantById(room, id) { return Array.from(room.participants.values()).find((p) => p.id === id); }
function getRoomMember(socket) {
  const room = getRoom(socket.data.roomCode);
  const participant = room?.participants.get(socket.id);
  return room && participant ? { room, participant } : null;
}
function getOwnedRoom(socket) {
  const member = getRoomMember(socket);
  return member?.room.ownerSocketId === socket.id ? member.room : null;
}
function sendParticipants(io, room) { io.to(room.code).emit('participants-updated', Array.from(room.participants.values())); }
function sendTypingUsers(io, room) {
  if (isPrivateRoom(room)) return;
  const users = Array.from(room.typingSocketIds).map((id) => room.participants.get(id)).filter(Boolean).map(({ id, name }) => ({ id, name }));
  io.to(room.code).emit('users-typing', { users });
}
function getRoomSnapshotWithTransport(room, socketId) {
  const privateRoom = isPrivateRoom(room);
  return {
    ...getRoomSnapshot(room, socketId),
    transport: privateRoom
      ? { mode: room.transportMode, ...getWebRtcConfiguration({ allowTurn: room.transportMode === TRANSPORT_MODES.PRIVATE_TURN }) }
      : { mode: TRANSPORT_MODES.GROUP_SERVER, enabled: false, iceServers: [] },
  };
}
function emitSystem(io, room, text) {
  if (isPrivateRoom(room)) return null;
  const message = addSystemMessage(room, text);
  io.to(room.code).emit('new-message', message);
  return message;
}
function sendAdminError(socket, action) { socket.emit('chat-error', { action, message: 'Только владелец комнаты может выполнить это действие.' }); }
function issueSocketSession(room, participant, socket) {
  const { token, tokenHash } = issueSession({ roomCode: room.code, participantId: participant.id, socketId: socket.id, name: participant.name });
  socket.data.sessionTokenHash = tokenHash;
  return token;
}
function sendSessionInvalid(socket, message = 'Сессия восстановления недействительна или истекла.') { socket.emit('session-invalid', { message }); }

function removeSocketFromCurrentRoom(io, socket, { reason = 'left', revokeSessionToken = false, systemText } = {}) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;
  const room = getRoom(roomCode);
  socket.data.roomCode = undefined;
  if (revokeSessionToken && socket.data.sessionTokenHash) {
    revokeSession(socket.data.sessionTokenHash);
    socket.data.sessionTokenHash = undefined;
  }
  socket.leave(roomCode);
  if (!room) return;
  const participant = removeParticipant(room, socket.id);
  if (!participant) return;
  room.typingSocketIds.delete(socket.id);
  sendTypingUsers(io, room);
  if (room.participants.size === 0) return;
  if (!isPrivateRoom(room)) emitSystem(io, room, systemText || `${participant.name} вышел из комнаты.`);
  io.to(room.code).emit('participant-left', { participant, reason });
  if (participant.socketId === room.ownerSocketId) {
    const nextOwner = assignNextOwner(room);
    if (nextOwner) {
      if (!isPrivateRoom(room)) emitSystem(io, room, `${nextOwner.name} назначен новым владельцем комнаты.`);
      io.to(room.code).emit('owner-changed', { owner: nextOwner });
    }
  }
  sendParticipants(io, room);
}

function relayWebRtcSignal(socket, event, payload, valueKey) {
  const member = getRoomMember(socket);
  const input = asObject(payload);
  if (!member || !isPrivateRoom(member.room) || !webRtcSignalLimiter.consume(socket.id).allowed) return;
  const target = findParticipantById(member.room, input.targetParticipantId);
  if (!target || target.socketId === socket.id) return;
  const targetSocket = socket.server.sockets.sockets.get(target.socketId);
  targetSocket?.emit(event, { fromParticipantId: member.participant.id, [valueKey]: input[valueKey] });
}

function trackDelivery(room, message, senderSocketId) {
  const recipientSocketIds = new Set(Array.from(room.participants.keys()).filter((id) => id !== senderSocketId));
  if (recipientSocketIds.size) pendingDeliveries.set(message.id, { roomCode: room.code, senderSocketId, recipientSocketIds, expiresAt: Date.now() + 120_000 });
  return Array.from(room.participants.values()).filter((p) => p.socketId !== senderSocketId).map((p) => p.id);
}

function registerSocketHandlers(io, { publicUrl }) {
  io.on('connection', (socket) => {
    on(socket, 'create-room', async (payload) => {
      const validation = validateCreateRoom(payload);
      if (!validation.valid) return socket.emit('room-error', { action: 'create-room', message: validation.message });
      if (rooms.size >= MAX_ACTIVE_ROOMS) return socket.emit('room-error', { action: 'create-room', code: 'active-room-limit', message: 'Сейчас создано слишком много комнат. Попробуйте позже.' });
      if (!roomCreationLimiter.consume(getClientAddress(socket)).allowed) {
        safeLog('room-creation-rate-limited');
        return socket.emit('room-error', { action: 'create-room', code: 'room-creation-rate-limit', message: 'Вы создаёте комнаты слишком часто. Попробуйте позже.' });
      }
      const room = await createRoom({ ...validation.data, ownerSocketId: socket.id });
      const owner = room.participants.get(socket.id);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.emit('room-created', {
        code: room.code,
        invitationUrl: `${publicUrl}/room.html?room=${encodeURIComponent(room.code)}`,
        maxParticipants: room.maxParticipants,
        transportMode: room.transportMode,
        sessionToken: issueSocketSession(room, owner, socket),
      });
    });

    on(socket, 'join-room', async (payload) => {
      const validation = validateJoinRoom(payload);
      if (!validation.valid) return socket.emit('chat-error', { action: 'join-room', message: validation.message });
      const { code, name, pin } = validation.data;
      const room = getRoom(code);
      if (!room) return socket.emit('room-not-found', { code, message: 'Комната не найдена или уже удалена.' });
      if (room.isLocked) return socket.emit('chat-error', { action: 'join-room', code: 'room-locked', message: 'Владелец временно запретил новые подключения.' });
      if (!joinLimiter.consume(getClientAddress(socket)).allowed) return socket.emit('chat-error', { action: 'join-room', code: 'join-rate-limit', message: 'Слишком много попыток входа. Попробуйте позже.' });
      const attemptKey = getAttemptKey(socket, code);
      const attemptState = getPinAttemptState(attemptKey);
      if (attemptState?.blockedUntil) return socket.emit('too-many-attempts', { message: 'Слишком много неверных попыток PIN. Попробуйте позже.', retryAfter: attemptState.blockedUntil });
      if (!await bcrypt.compare(pin, room.pinHash)) {
        const failed = recordFailedPinAttempt(attemptKey);
        return socket.emit('invalid-pin', { message: 'Неверный PIN-код.', attemptsRemaining: Math.max(0, MAX_FAILED_PIN_ATTEMPTS - failed.count) });
      }
      if (isNameTaken(room, name)) return socket.emit('name-taken', { message: 'Это имя уже используется в комнате.' });
      if (room.participants.size >= room.maxParticipants) return socket.emit('room-full', { message: 'В комнате уже нет свободных мест.' });
      removeSocketFromCurrentRoom(io, socket, { revokeSessionToken: true });
      const participant = addParticipant(room, { id: socket.id, name });
      socket.join(room.code);
      socket.data.roomCode = room.code;
      pinAttempts.delete(attemptKey);
      const sessionToken = issueSocketSession(room, participant, socket);
      socket.emit('room-joined', { ...getRoomSnapshotWithTransport(room, socket.id), sessionToken });
      socket.to(room.code).emit('participant-joined', { participant });
      sendParticipants(io, room);
      if (!isPrivateRoom(room)) emitSystem(io, room, `${participant.name} присоединился к комнате.`);
    });

    on(socket, 'resume-session', (payload) => {
      const { code, token } = asObject(payload);
      const roomCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
      if (!resumeLimiter.consume(getClientAddress(socket)).allowed) return sendSessionInvalid(socket, 'Слишком много попыток восстановления. Попробуйте позже.');
      const sessionResult = getSession(token);
      if (!sessionResult || sessionResult.session.roomCode !== roomCode) return sendSessionInvalid(socket);
      const room = getRoom(roomCode);
      if (!room) { revokeSession(sessionResult.tokenHash); return sendSessionInvalid(socket, 'Комната больше недоступна.'); }
      let participant = findParticipantById(room, sessionResult.session.participantId);
      if (!participant && (isNameTaken(room, sessionResult.session.name) || room.participants.size >= room.maxParticipants)) {
        revokeSession(sessionResult.tokenHash); return sendSessionInvalid(socket, 'Восстановить участие в комнате не удалось.');
      }
      removeSocketFromCurrentRoom(io, socket, { revokeSessionToken: true });
      if (participant) {
        const previousSocket = io.sockets.sockets.get(participant.socketId);
        room.participants.delete(participant.socketId);
        participant.socketId = socket.id;
        room.participants.set(socket.id, participant);
        if (room.ownerSocketId === previousSocket?.id) room.ownerSocketId = socket.id;
        previousSocket?.disconnect(true);
      } else {
        participant = addParticipant(room, { id: socket.id, name: sessionResult.session.name });
        sessionResult.session.participantId = participant.id;
      }
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.sessionTokenHash = sessionResult.tokenHash;
      room.lastActivityAt = Date.now();
      bindSession(sessionResult.tokenHash, socket.id);
      socket.emit('session-resumed', getRoomSnapshotWithTransport(room, socket.id));
      socket.to(room.code).emit('participant-reconnected', { participant });
      sendParticipants(io, room);
      sendTypingUsers(io, room);
    });

    on(socket, 'kick-participant', (payload) => {
      const room = getOwnedRoom(socket);
      const participant = room && findParticipantById(room, asObject(payload).participantId);
      if (!room) return sendAdminError(socket, 'kick-participant');
      if (!participant) return socket.emit('chat-error', { action: 'kick-participant', message: 'Участник уже покинул комнату.' });
      if (participant.socketId === socket.id) return socket.emit('chat-error', { action: 'kick-participant', message: 'Владелец не может удалить самого себя.' });
      const targetSocket = io.sockets.sockets.get(participant.socketId);
      if (!targetSocket) return socket.emit('chat-error', { action: 'kick-participant', message: 'Участник уже отключился.' });
      removeSocketFromCurrentRoom(io, targetSocket, { reason: 'kicked', revokeSessionToken: true, systemText: `${participant.name} удалён владельцем комнаты.` });
      targetSocket.emit('participant-kicked', { message: 'Владелец удалил вас из комнаты.' });
    });

    on(socket, 'clear-chat', () => {
      const room = getOwnedRoom(socket);
      if (!room) return sendAdminError(socket, 'clear-chat');
      if (isPrivateRoom(room)) return socket.emit('chat-error', { action: 'clear-chat', message: 'В приватной P2P-комнате история не хранится.' });
      const message = clearHistory(room, 'История сообщений очищена.');
      io.to(room.code).emit('chat-cleared', { message });
    });
    on(socket, 'lock-room', () => {
      const room = getOwnedRoom(socket); if (!room) return sendAdminError(socket, 'lock-room');
      room.isLocked = true; room.lastActivityAt = Date.now(); io.to(room.code).emit('room-settings-updated', { isLocked: true, maxParticipants: room.maxParticipants });
    });
    on(socket, 'unlock-room', () => {
      const room = getOwnedRoom(socket); if (!room) return sendAdminError(socket, 'unlock-room');
      room.isLocked = false; room.lastActivityAt = Date.now(); io.to(room.code).emit('room-settings-updated', { isLocked: false, maxParticipants: room.maxParticipants });
    });
    on(socket, 'update-room-settings', (payload) => {
      const room = getOwnedRoom(socket); if (!room) return sendAdminError(socket, 'update-room-settings');
      if (isPrivateRoom(room)) return socket.emit('chat-error', { action: 'update-room-settings', message: 'В приватной P2P-комнате лимит всегда равен двум.' });
      const validation = validateMaxParticipants(asObject(payload).maxParticipants);
      if (!validation.valid) return socket.emit('chat-error', { action: 'update-room-settings', message: validation.message });
      if (validation.value < room.participants.size) return socket.emit('chat-error', { action: 'update-room-settings', message: 'Новый лимит не может быть меньше текущего числа участников.' });
      room.maxParticipants = validation.value; room.lastActivityAt = Date.now();
      io.to(room.code).emit('room-settings-updated', { isLocked: room.isLocked, maxParticipants: room.maxParticipants });
    });
    on(socket, 'close-room', () => {
      const room = getOwnedRoom(socket); if (!room) return sendAdminError(socket, 'close-room');
      io.to(room.code).emit('room-closed', { message: 'Комната закрыта.' });
      revokeRoomSessions(room.code); clearPinAttemptsForRoom(room.code); closeRoom(room); io.in(room.code).disconnectSockets(true);
    });

    on(socket, 'webrtc-offer', (payload) => {
      const description = asObject(payload).description;
      if (description?.type === 'offer' && typeof description.sdp === 'string' && description.sdp.length <= 12_000) relayWebRtcSignal(socket, 'webrtc-offer', payload, 'description');
    });
    on(socket, 'webrtc-answer', (payload) => {
      const description = asObject(payload).description;
      if (description?.type === 'answer' && typeof description.sdp === 'string' && description.sdp.length <= 12_000) relayWebRtcSignal(socket, 'webrtc-answer', payload, 'description');
    });
    on(socket, 'webrtc-ice-candidate', (payload) => {
      const candidate = asObject(payload).candidate;
      if (candidate === null || (candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 4096)) relayWebRtcSignal(socket, 'webrtc-ice-candidate', payload, 'candidate');
    });

    on(socket, 'send-message', (payload) => {
      const member = getRoomMember(socket);
      if (!member) return socket.emit('chat-error', { action: 'send-message', message: 'Сначала войдите в комнату, чтобы отправлять сообщения.' });
      if (isPrivateRoom(member.room)) return socket.emit('chat-error', { action: 'send-message', message: 'Приватные сообщения отправляются только по защищённому P2P-каналу.' });
      const validation = validateMessage(payload);
      if (!validation.valid) return socket.emit('chat-error', { action: 'send-message', message: validation.message });
      const attempt = messageLimiter.consume(socket.id);
      if (!attempt.allowed) { safeLog('message-rate-limited'); return socket.emit('chat-error', { action: 'send-message', code: 'message-rate-limit', message: 'Слишком много сообщений. Подождите несколько секунд.' }); }
      const message = addUserMessage(member.room, { senderId: member.participant.id, senderName: member.participant.name, text: validation.data.text });
      const expectedParticipantIds = trackDelivery(member.room, message, socket.id);
      io.to(member.room.code).emit('new-message', message);
      socket.emit('message-delivery-expected', { messageId: message.id, participantIds: expectedParticipantIds });
    });
    on(socket, 'message-delivery-received', (payload) => {
      const member = getRoomMember(socket);
      const messageId = asObject(payload).messageId;
      const pending = pendingDeliveries.get(messageId);
      if (!member || isPrivateRoom(member.room) || !pending || pending.roomCode !== member.room.code || !pending.recipientSocketIds.delete(socket.id)) return;
      io.sockets.sockets.get(pending.senderSocketId)?.emit('message-delivery-update', { messageId, participantId: member.participant.id });
      if (!pending.recipientSocketIds.size) pendingDeliveries.delete(messageId);
    });
    on(socket, 'typing-start', () => {
      const member = getRoomMember(socket);
      if (!member || isPrivateRoom(member.room) || !typingLimiter.consume(socket.id).allowed || member.room.typingSocketIds.has(socket.id)) return;
      member.room.typingSocketIds.add(socket.id); sendTypingUsers(io, member.room);
    });
    on(socket, 'typing-stop', () => {
      const member = getRoomMember(socket);
      if (!member || isPrivateRoom(member.room) || !typingLimiter.consume(socket.id).allowed || !member.room.typingSocketIds.delete(socket.id)) return;
      sendTypingUsers(io, member.room);
    });
    on(socket, 'leave-room', (ack) => { removeSocketFromCurrentRoom(io, socket, { revokeSessionToken: true }); if (typeof ack === 'function') ack({ ok: true }); });
    on(socket, 'disconnect', () => { removeSocketFromCurrentRoom(io, socket); messageLimiter.remove(socket.id); typingLimiter.remove(socket.id); });
  });
}

module.exports = { clearPinAttemptsForRoom, registerSocketHandlers, resetSocketState };
