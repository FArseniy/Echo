const bcrypt = require('bcrypt');
const {
  addParticipant,
  addSystemMessage,
  addUserMessage,
  assignNextOwner,
  clearHistory,
  closeRoom,
  createRoom,
  getRoom,
  getRoomSnapshot,
  removeParticipant,
  rooms,
} = require('./rooms');
const {
  joinLimiter,
  messageLimiter,
  resumeLimiter,
  roomCreationLimiter,
  typingLimiter,
  webRtcSignalLimiter,
} = require('./limits');
const { getWebRtcConfiguration } = require('./turnCredentials');
const { getMessageSigningPublicKey, signMessage } = require('./messageSigner');
const {
  bindSession,
  getSession,
  issueSession,
  revokeRoomSessions,
  revokeSession,
} = require('./sessions');
const {
  asObject,
  validateCreateRoom,
  validateJoinRoom,
  validateMaxParticipants,
  validateMessage,
} = require('./validation');

function readPositiveInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const MAX_FAILED_PIN_ATTEMPTS = readPositiveInteger('PIN_ATTEMPT_LIMIT', 5, { min: 1, max: 20 });
const PIN_BLOCK_MS = readPositiveInteger('PIN_BLOCK_MINUTES', 5, { min: 1, max: 60 }) * 60 * 1000;
const PIN_ATTEMPT_WINDOW_MS = PIN_BLOCK_MS;
const MAX_ACTIVE_ROOMS = 1000;
const pinAttempts = new Map();
const pendingRelayDeliveries = new Map();

function getClientAddress(socket) {
  const realIp = socket.handshake.headers['x-real-ip'];
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) return forwardedFor.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

function safeLog(event, socket, details = {}) {
  console.warn('[echo]', JSON.stringify({
    event,
    socketId: socket.id,
    clientIp: getClientAddress(socket),
    ...details,
  }));
}

function on(socket, event, handler) {
  socket.on(event, (...args) => {
    Promise.resolve()
      .then(() => handler(...args))
      .catch((error) => {
        safeLog('socket-handler-failed', socket, { event, errorName: error?.name || 'Error' });
        socket.emit(event === 'create-room' ? 'room-error' : 'chat-error', {
          action: event,
          message: 'Не удалось обработать запрос. Попробуйте ещё раз.',
        });
      });
  });
}

function getAttemptKey(socket, roomCode) {
  return `${getClientAddress(socket)}:${roomCode}`;
}

function getPinAttemptState(key) {
  const state = pinAttempts.get(key);
  const now = Date.now();

  if (!state || now - state.lastFailedAt > PIN_ATTEMPT_WINDOW_MS) {
    pinAttempts.delete(key);
    return null;
  }

  if (state.blockedUntil && state.blockedUntil > now) return state;
  if (state.blockedUntil) pinAttempts.delete(key);
  return state.blockedUntil ? null : state;
}

function recordFailedPinAttempt(key) {
  const now = Date.now();
  const previous = getPinAttemptState(key);
  const count = (previous?.count || 0) + 1;
  const state = {
    count,
    lastFailedAt: now,
    blockedUntil: count >= MAX_FAILED_PIN_ATTEMPTS ? now + PIN_BLOCK_MS : null,
  };

  pinAttempts.set(key, state);
  return state;
}

function cleanupPinAttempts() {
  const now = Date.now();
  for (const [key, state] of pinAttempts) {
    const isExpired = !state || now - state.lastFailedAt > PIN_ATTEMPT_WINDOW_MS;
    const isUnblocked = state?.blockedUntil && state.blockedUntil <= now;
    if (isExpired || isUnblocked) pinAttempts.delete(key);
  }
}

setInterval(() => {
  cleanupPinAttempts();
  cleanupPendingRelayDeliveries();
}, 60 * 1000).unref();

function clearPinAttemptsForRoom(roomCode) {
  const suffix = `:${roomCode}`;
  for (const key of pinAttempts.keys()) {
    if (key.endsWith(suffix)) pinAttempts.delete(key);
  }
}

function resetSocketState() {
  pinAttempts.clear();
}

function isNameTaken(room, name) {
  const wanted = name.toLocaleLowerCase('ru');
  return Array.from(room.participants.values()).some((participant) => participant.name.toLocaleLowerCase('ru') === wanted);
}

function sendParticipants(io, room) {
  io.to(room.code).emit('participants-updated', Array.from(room.participants.values()));
}

function sendTypingUsers(io, room) {
  const users = Array.from(room.typingSocketIds || [])
    .map((socketId) => room.participants.get(socketId))
    .filter(Boolean)
    .map((participant) => ({ id: participant.id, name: participant.name }));

  io.to(room.code).emit('users-typing', { users });
}

function findParticipantById(room, participantId) {
  return Array.from(room.participants.values()).find((participant) => participant.id === participantId);
}

function getOwnedRoom(socket) {
  const room = getRoom(socket.data.roomCode);
  return room && room.ownerSocketId === socket.id ? room : null;
}

function getRoomMember(socket) {
  const room = getRoom(socket.data.roomCode);
  const participant = room?.participants.get(socket.id);
  return room && participant ? { room, participant } : null;
}

function getRoomSnapshotWithTransport(room, socketId) {
  return {
    ...getRoomSnapshot(room, socketId),
    transport: {
      ...getWebRtcConfiguration(),
      messageSigningPublicKey: getMessageSigningPublicKey(),
    },
  };
}

function getTargetParticipant(room, participantId) {
  if (typeof participantId !== 'string' || participantId.length > 64) return null;
  return findParticipantById(room, participantId);
}

function getStoredUserMessage(room, messageId) {
  if (typeof messageId !== 'string' || messageId.length > 64) return null;
  return room.messages.find((message) => message.id === messageId && message.type === 'user') || null;
}

function clearPendingRelaysForRoom(roomCode) {
  for (const [messageId, state] of pendingRelayDeliveries) {
    if (state.roomCode === roomCode) pendingRelayDeliveries.delete(messageId);
  }
}

function cleanupPendingRelayDeliveries() {
  const now = Date.now();
  for (const [messageId, state] of pendingRelayDeliveries) {
    if (state.expiresAt <= now || state.recipientSocketIds.size === 0) pendingRelayDeliveries.delete(messageId);
  }
}

function relayWebRtcSignal(socket, event, payload, valueKey) {
  const { targetParticipantId, [valueKey]: value } = asObject(payload);
  const member = getRoomMember(socket);
  if (!member || !webRtcSignalLimiter.consume(socket.id).allowed) return;

  const target = getTargetParticipant(member.room, targetParticipantId);
  const targetSocket = target && socket.server.sockets.sockets.get(target.socketId);
  if (!targetSocket || target.socketId === socket.id) return;

  targetSocket.emit(event, {
    fromParticipantId: member.participant.id,
    [valueKey]: value,
  });
}

function sendAdminError(socket, action) {
  socket.emit('chat-error', { action, message: 'Только владелец комнаты может выполнить это действие.' });
}

function broadcastSystemMessage(io, room, message) {
  io.to(room.code).emit('new-message', message);
}

function removeSocketFromCurrentRoom(io, socket, { systemText, reason = 'left', revokeSessionToken = false } = {}) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = getRoom(code);
  if (room) {
    const participant = removeParticipant(room, socket.id);
    socket.leave(code);

    if (participant) {
      room.typingSocketIds?.delete(socket.id);
      sendTypingUsers(io, room);
      const leftMessage = addSystemMessage(room, systemText || `${participant.name} вышел из комнаты.`);

      if (room.participants.size !== 0) {
        broadcastSystemMessage(io, room, leftMessage);
        io.to(room.code).emit('participant-left', { participant, reason });

        if (participant.socketId === room.ownerSocketId) {
          const nextOwner = assignNextOwner(room);
          const ownerMessage = addSystemMessage(room, `${nextOwner.name} назначен новым владельцем комнаты.`);
          broadcastSystemMessage(io, room, ownerMessage);
          io.to(room.code).emit('owner-changed', { owner: nextOwner });
        }

        sendParticipants(io, room);
      }
    }
  } else {
    socket.leave(code);
  }

  socket.data.roomCode = undefined;
  if (revokeSessionToken && socket.data.sessionTokenHash) {
    revokeSession(socket.data.sessionTokenHash);
    socket.data.sessionTokenHash = undefined;
  }
}

function issueSocketSession(room, participant, socket) {
  const { token, tokenHash } = issueSession({
    roomCode: room.code,
    participantId: participant.id,
    socketId: socket.id,
    name: participant.name,
  });
  socket.data.sessionTokenHash = tokenHash;
  return token;
}

function sendSessionInvalid(socket, message = 'Сессия восстановления недействительна или истекла.') {
  socket.emit('session-invalid', { message });
}

function resumeParticipant(io, socket, session) {
  const room = getRoom(session.roomCode);
  if (!room) return null;

  const existingParticipant = findParticipantById(room, session.participantId);
  if (existingParticipant) {
    const previousSocketId = existingParticipant.socketId;
    const previousSocket = io.sockets.sockets.get(previousSocketId);
    if (previousSocketId !== socket.id) {
      room.participants.delete(previousSocketId);
      room.typingSocketIds?.delete(previousSocketId);
      existingParticipant.socketId = socket.id;
      room.participants.set(socket.id, existingParticipant);
      if (room.ownerSocketId === previousSocketId) room.ownerSocketId = socket.id;

      if (previousSocket) {
        previousSocket.data.roomCode = undefined;
        previousSocket.data.sessionTokenHash = undefined;
        previousSocket.leave(room.code);
        previousSocket.emit('session-invalid', { message: 'Сессия открыта в другом подключении.' });
        previousSocket.disconnect(true);
      }
    }
    return existingParticipant;
  }

  return addParticipant(room, { id: socket.id, name: session.name });
}

function registerSocketHandlers(io, { publicUrl }) {
  io.on('connection', (socket) => {
    console.log(`Клиент подключён: ${socket.id}`);

    on(socket, 'create-room', async (payload) => {
      const validation = validateCreateRoom(payload);
      if (!validation.valid) {
        socket.emit('room-error', { action: 'create-room', message: validation.message });
        return;
      }

      if (rooms.size >= MAX_ACTIVE_ROOMS) {
        safeLog('active-room-limit', socket);
        socket.emit('room-error', { action: 'create-room', code: 'active-room-limit', message: 'Сейчас создано слишком много комнат. Попробуйте позже.' });
        return;
      }

      const creationAttempt = roomCreationLimiter.consume(getClientAddress(socket));
      if (!creationAttempt.allowed) {
        safeLog('room-creation-rate-limited', socket);
        socket.emit('room-error', {
          action: 'create-room',
          code: 'room-creation-rate-limit',
          message: 'Вы создаёте комнаты слишком часто. Попробуйте позже.',
          retryAfter: creationAttempt.retryAfter,
        });
        return;
      }

      try {
        const room = await createRoom({ ...validation.data, ownerSocketId: socket.id });
        const owner = room.participants.get(socket.id);
        socket.join(room.code);
        socket.data.roomCode = room.code;
        const sessionToken = issueSocketSession(room, owner, socket);
        socket.emit('room-created', {
          code: room.code,
          invitationUrl: `${publicUrl}/room.html?room=${encodeURIComponent(room.code)}`,
          maxParticipants: room.maxParticipants,
          sessionToken,
        });
      } catch (error) {
        safeLog('room-creation-failed', socket, { errorName: error?.name || 'Error' });
        socket.emit('room-error', { action: 'create-room', message: 'Не удалось создать комнату. Попробуйте ещё раз.' });
      }
    });

    on(socket, 'join-room', async (payload) => {
      const validation = validateJoinRoom(payload);
      if (!validation.valid) {
        socket.emit('chat-error', { action: 'join-room', message: validation.message });
        return;
      }

      const { code, name, pin } = validation.data;
      const room = getRoom(code);
      if (!room) {
        socket.emit('room-not-found', { code, message: 'Комната не найдена или уже удалена.' });
        return;
      }

      if (room.isLocked) {
        socket.emit('chat-error', {
          action: 'join-room',
          code: 'room-locked',
          message: 'Владелец временно запретил новые подключения к комнате.',
        });
        return;
      }

      const joinAttempt = joinLimiter.consume(getClientAddress(socket));
      if (!joinAttempt.allowed) {
        safeLog('join-rate-limited', socket);
        socket.emit('chat-error', {
          action: 'join-room',
          code: 'join-rate-limit',
          message: 'Слишком много попыток входа. Попробуйте позже.',
          retryAfter: joinAttempt.retryAfter,
        });
        return;
      }

      const attemptKey = getAttemptKey(socket, code);
      const attemptState = getPinAttemptState(attemptKey);
      if (attemptState?.blockedUntil) {
        safeLog('pin-rate-limited', socket);
        socket.emit('too-many-attempts', {
          message: 'Слишком много неверных попыток PIN. Попробуйте позже.',
          retryAfter: attemptState.blockedUntil,
        });
        return;
      }

      const isCorrectPin = await bcrypt.compare(pin, room.pinHash);
      if (!isCorrectPin) {
        const failedAttempt = recordFailedPinAttempt(attemptKey);
        socket.emit('invalid-pin', {
          message: 'Неверный PIN-код.',
          attemptsRemaining: Math.max(0, MAX_FAILED_PIN_ATTEMPTS - failedAttempt.count),
        });
        return;
      }

      if (isNameTaken(room, name)) {
        socket.emit('name-taken', { message: 'Это имя уже используется в комнате.' });
        return;
      }

      if (room.participants.size >= room.maxParticipants) {
        socket.emit('room-full', { message: 'В комнате уже нет свободных мест.' });
        return;
      }

      removeSocketFromCurrentRoom(io, socket, { revokeSessionToken: true });
      const participant = addParticipant(room, { id: socket.id, name });
      socket.join(room.code);
      socket.data.roomCode = room.code;
      pinAttempts.delete(attemptKey);
      const sessionToken = issueSocketSession(room, participant, socket);
      const systemMessage = addSystemMessage(room, `${participant.name} присоединился к комнате.`);

      socket.emit('room-joined', { ...getRoomSnapshotWithTransport(room, socket.id), sessionToken });
      socket.to(room.code).emit('participant-joined', { participant, message: systemMessage });
      sendParticipants(io, room);
    });

    on(socket, 'resume-session', (payload) => {
      const { code, token } = asObject(payload);
      const requestedRoomCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
      const resumeAttempt = resumeLimiter.consume(getClientAddress(socket));
      if (!resumeAttempt.allowed) {
        safeLog('resume-rate-limited', socket);
        sendSessionInvalid(socket, 'Слишком много попыток восстановления. Попробуйте позже.');
        return;
      }
      const sessionResult = getSession(token);
      if (!sessionResult || sessionResult.session.roomCode !== requestedRoomCode) {
        sendSessionInvalid(socket);
        return;
      }

      const room = getRoom(requestedRoomCode);
      if (!room) {
        revokeSession(sessionResult.tokenHash);
        sendSessionInvalid(socket, 'Комната больше недоступна.');
        return;
      }

      const existingParticipant = findParticipantById(room, sessionResult.session.participantId);
      if (!existingParticipant && (isNameTaken(room, sessionResult.session.name) || room.participants.size >= room.maxParticipants)) {
        revokeSession(sessionResult.tokenHash);
        sendSessionInvalid(socket, 'Восстановить участие в комнате не удалось.');
        return;
      }

      removeSocketFromCurrentRoom(io, socket, { revokeSessionToken: true });
      const participant = resumeParticipant(io, socket, sessionResult.session);
      if (!participant) {
        sendSessionInvalid(socket);
        return;
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
      const { participantId } = asObject(payload);
      const room = getOwnedRoom(socket);
      if (!room) {
        sendAdminError(socket, 'kick-participant');
        return;
      }

      const participant = Array.from(room.participants.values()).find((item) => item.id === participantId);
      if (!participant) {
        socket.emit('chat-error', { action: 'kick-participant', message: 'Участник уже покинул комнату.' });
        return;
      }

      if (participant.socketId === socket.id) {
        socket.emit('chat-error', { action: 'kick-participant', message: 'Владелец не может удалить самого себя.' });
        return;
      }

      const targetSocket = io.sockets.sockets.get(participant.socketId);
      if (!targetSocket) {
        socket.emit('chat-error', { action: 'kick-participant', message: 'Участник уже отключился.' });
        return;
      }

      removeSocketFromCurrentRoom(io, targetSocket, {
        systemText: `${participant.name} удалён владельцем комнаты.`,
        reason: 'kicked',
        revokeSessionToken: true,
      });
      targetSocket.emit('participant-kicked', { message: 'Владелец удалил вас из комнаты.' });
    });

    on(socket, 'clear-chat', () => {
      const room = getOwnedRoom(socket);
      if (!room) {
        sendAdminError(socket, 'clear-chat');
        return;
      }

      const message = clearHistory(room, 'История сообщений очищена.');
      io.to(room.code).emit('chat-cleared', { message });
    });

    on(socket, 'lock-room', () => {
      const room = getOwnedRoom(socket);
      if (!room) {
        sendAdminError(socket, 'lock-room');
        return;
      }

      room.isLocked = true;
      room.lastActivityAt = Date.now();
      io.to(room.code).emit('room-settings-updated', { isLocked: room.isLocked, maxParticipants: room.maxParticipants });
    });

    on(socket, 'unlock-room', () => {
      const room = getOwnedRoom(socket);
      if (!room) {
        sendAdminError(socket, 'unlock-room');
        return;
      }

      room.isLocked = false;
      room.lastActivityAt = Date.now();
      io.to(room.code).emit('room-settings-updated', { isLocked: room.isLocked, maxParticipants: room.maxParticipants });
    });

    on(socket, 'update-room-settings', (payload) => {
      const { maxParticipants } = asObject(payload);
      const room = getOwnedRoom(socket);
      if (!room) {
        sendAdminError(socket, 'update-room-settings');
        return;
      }

      const validation = validateMaxParticipants(maxParticipants);
      if (!validation.valid) {
        socket.emit('chat-error', { action: 'update-room-settings', message: validation.message });
        return;
      }

      if (validation.value < room.participants.size) {
        socket.emit('chat-error', { action: 'update-room-settings', message: 'Новый лимит не может быть меньше текущего числа участников.' });
        return;
      }

      room.maxParticipants = validation.value;
      room.lastActivityAt = Date.now();
      io.to(room.code).emit('room-settings-updated', { isLocked: room.isLocked, maxParticipants: room.maxParticipants });
    });

    on(socket, 'close-room', () => {
      const room = getOwnedRoom(socket);
      if (!room) {
        sendAdminError(socket, 'close-room');
        return;
      }

      const message = addSystemMessage(room, 'Комната закрыта.');
      broadcastSystemMessage(io, room, message);
      io.to(room.code).emit('room-closed', { message });

      revokeRoomSessions(room.code);
      clearPinAttemptsForRoom(room.code);
      clearPendingRelaysForRoom(room.code);
      closeRoom(room);
      io.in(room.code).disconnectSockets(true);
    });

    on(socket, 'webrtc-offer', (payload) => {
      const { description } = asObject(payload);
      if (!description || description.type !== 'offer' || typeof description.sdp !== 'string' || description.sdp.length > 12_000) return;
      relayWebRtcSignal(socket, 'webrtc-offer', payload, 'description');
    });

    on(socket, 'webrtc-answer', (payload) => {
      const { description } = asObject(payload);
      if (!description || description.type !== 'answer' || typeof description.sdp !== 'string' || description.sdp.length > 12_000) return;
      relayWebRtcSignal(socket, 'webrtc-answer', payload, 'description');
    });

    on(socket, 'webrtc-ice-candidate', (payload) => {
      const { candidate } = asObject(payload);
      if (candidate !== null && (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4_096)) return;
      relayWebRtcSignal(socket, 'webrtc-ice-candidate', payload, 'candidate');
    });

    on(socket, 'p2p-prepare-message', (payload) => {
      const validation = validateMessage(payload);
      const member = getRoomMember(socket);
      if (!validation.valid || !member) {
        socket.emit('chat-error', { action: 'send-message', message: validation.message || 'Сначала войдите в комнату, чтобы отправлять сообщения.' });
        return;
      }

      const messageAttempt = messageLimiter.consume(socket.id);
      if (!messageAttempt.allowed) {
        safeLog('message-rate-limited', socket);
        socket.emit('chat-error', {
          action: 'send-message',
          code: 'message-rate-limit',
          message: 'Слишком много сообщений. Подождите несколько секунд.',
          retryAfter: messageAttempt.retryAfter,
        });
        return;
      }

      const message = addUserMessage(member.room, {
        senderId: member.participant.id,
        senderName: member.participant.name,
        text: validation.data.text,
      });
      socket.emit('p2p-message-prepared', { message, signature: signMessage(message) });
    });

    on(socket, 'p2p-relay-message', (payload) => {
      const { messageId, targetParticipantIds } = asObject(payload);
      const member = getRoomMember(socket);
      if (!member || !Array.isArray(targetParticipantIds) || targetParticipantIds.length > member.room.participants.size) return;

      const message = getStoredUserMessage(member.room, messageId);
      if (!message || message.senderId !== member.participant.id) return;

      const recipientSocketIds = new Set();
      for (const participantId of new Set(targetParticipantIds)) {
        const target = getTargetParticipant(member.room, participantId);
        if (!target || target.socketId === socket.id) continue;
        const targetSocket = socket.server.sockets.sockets.get(target.socketId);
        if (!targetSocket) continue;
        recipientSocketIds.add(target.socketId);
        targetSocket.emit('p2p-relay-message', { message });
      }

      if (recipientSocketIds.size > 0) {
        const pending = pendingRelayDeliveries.get(message.id) || {
          roomCode: member.room.code,
          senderSocketId: socket.id,
          recipientSocketIds: new Set(),
          expiresAt: 0,
        };
        recipientSocketIds.forEach((socketId) => pending.recipientSocketIds.add(socketId));
        pending.expiresAt = Date.now() + 2 * 60 * 1000;
        pendingRelayDeliveries.set(message.id, pending);
      }
    });

    on(socket, 'p2p-delivery-received', (payload) => {
      const { messageId } = asObject(payload);
      const member = getRoomMember(socket);
      const pending = pendingRelayDeliveries.get(messageId);
      if (!member || !pending || pending.roomCode !== member.room.code || !pending.recipientSocketIds.delete(socket.id)) return;

      const senderSocket = socket.server.sockets.sockets.get(pending.senderSocketId);
      senderSocket?.emit('message-delivery-update', { messageId, participantId: member.participant.id });
      if (pending.recipientSocketIds.size === 0) pendingRelayDeliveries.delete(messageId);
    });

    on(socket, 'send-message', (payload) => {
      const validation = validateMessage(payload);
      if (!validation.valid) {
        safeLog('message-validation-failed', socket);
        socket.emit('chat-error', { action: 'send-message', message: validation.message });
        return;
      }

      const room = getRoom(socket.data.roomCode);
      const participant = room?.participants.get(socket.id);
      if (!room || !participant) {
        socket.emit('chat-error', {
          action: 'send-message',
          message: 'Сначала войдите в комнату, чтобы отправлять сообщения.',
        });
        return;
      }

      const messageAttempt = messageLimiter.consume(socket.id);
      if (!messageAttempt.allowed) {
        safeLog('message-rate-limited', socket);
        socket.emit('chat-error', {
          action: 'send-message',
          code: 'message-rate-limit',
          message: 'Слишком много сообщений. Подождите несколько секунд.',
          retryAfter: messageAttempt.retryAfter,
        });
        return;
      }

      const message = addUserMessage(room, {
        senderId: participant.id,
        senderName: participant.name,
        text: validation.data.text,
      });

      io.to(room.code).emit('new-message', message);
    });

    on(socket, 'typing-start', () => {
      const room = getRoom(socket.data.roomCode);
      const participant = room?.participants.get(socket.id);
      if (!room || !participant) return;
      if (!typingLimiter.consume(socket.id).allowed) return;
      if (room.typingSocketIds.has(socket.id)) return;

      room.typingSocketIds.add(socket.id);
      sendTypingUsers(io, room);
    });

    on(socket, 'typing-stop', () => {
      const room = getRoom(socket.data.roomCode);
      const participant = room?.participants.get(socket.id);
      if (!room || !participant) return;
      if (!typingLimiter.consume(socket.id).allowed) return;
      if (!room.typingSocketIds?.delete(socket.id)) return;

      sendTypingUsers(io, room);
    });

    on(socket, 'leave-room', (acknowledge) => {
      removeSocketFromCurrentRoom(io, socket, { revokeSessionToken: true });
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    });

    on(socket, 'disconnect', () => {
      removeSocketFromCurrentRoom(io, socket);
      messageLimiter.remove(socket.id);
      typingLimiter.remove(socket.id);
      console.log(`Клиент отключён: ${socket.id}`);
    });
  });
}

module.exports = { clearPinAttemptsForRoom, registerSocketHandlers, resetSocketState };
