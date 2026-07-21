const crypto = require('crypto');
const bcrypt = require('bcrypt');

const rooms = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 8;
const BCRYPT_ROUNDS = 12;
const MAX_STORED_MESSAGES = 100;

function generateRoomCode() {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function getUniqueRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error('Не удалось сгенерировать уникальный код комнаты.');
}

function makeParticipant({ socketId, name, role = 'member', joinedAt = Date.now() }) {
  return {
    id: crypto.randomUUID(),
    socketId,
    name,
    role,
    joinedAt,
  };
}

async function createRoom({ name, pin, maxParticipants, ownerSocketId }) {
  const code = getUniqueRoomCode();
  const now = Date.now();
  const owner = makeParticipant({ socketId: ownerSocketId, name, role: 'owner', joinedAt: now });
  const room = {
    id: crypto.randomUUID(),
    code,
    pinHash: await bcrypt.hash(pin, BCRYPT_ROUNDS),
    ownerSocketId,
    maxParticipants,
    isLocked: false,
    participants: new Map([[ownerSocketId, owner]]),
    typingSocketIds: new Set(),
    messages: [],
    createdAt: now,
    lastActivityAt: now,
  };

  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function addParticipant(room, { id, name }) {
  const participant = makeParticipant({
    socketId: id,
    name,
    role: room.participants.size === 0 ? 'owner' : 'member',
  });
  room.participants.set(id, participant);
  if (participant.role === 'owner') room.ownerSocketId = participant.socketId;
  room.lastActivityAt = Date.now();
  return participant;
}

function removeParticipant(room, socketId) {
  const participant = room.participants.get(socketId);
  if (!participant) return null;
  room.participants.delete(socketId);
  room.lastActivityAt = Date.now();
  return participant;
}

function addSystemMessage(room, text) {
  return storeMessage(room, {
    id: crypto.randomUUID(),
    type: 'system',
    text,
    createdAt: Date.now(),
  });
}

function addUserMessage(room, { senderId, senderName, text }) {
  return storeMessage(room, {
    id: crypto.randomUUID(),
    senderId,
    senderName,
    text,
    createdAt: Date.now(),
    type: 'user',
  });
}

function assignNextOwner(room) {
  const nextOwner = Array.from(room.participants.values())
    .sort((first, second) => first.joinedAt - second.joinedAt)[0];

  if (!nextOwner) return null;
  nextOwner.role = 'owner';
  room.ownerSocketId = nextOwner.socketId;
  room.lastActivityAt = Date.now();
  return nextOwner;
}

function clearHistory(room, text) {
  room.messages.length = 0;
  return addSystemMessage(room, text);
}

function closeRoom(room) {
  room.pinHash = undefined;
  room.messages.length = 0;
  room.participants.clear();
  room.typingSocketIds?.clear();
  rooms.delete(room.code);
}

function resetRooms() {
  for (const room of Array.from(rooms.values())) closeRoom(room);
}

function storeMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > MAX_STORED_MESSAGES) room.messages.shift();
  room.lastActivityAt = message.createdAt;
  return message;
}

function getRoomSnapshot(room, socketId) {
  const selfParticipant = room.participants.get(socketId);
  return {
    room: {
      code: room.code,
      maxParticipants: room.maxParticipants,
      isLocked: room.isLocked,
      createdAt: room.createdAt,
      isOwner: room.ownerSocketId === socketId,
    },
    selfParticipantId: selfParticipant?.id || null,
    participants: Array.from(room.participants.values()),
    messages: room.messages.slice(-50),
  };
}

module.exports = {
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
  resetRooms,
  rooms,
};
