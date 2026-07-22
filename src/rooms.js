const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { PRIVATE_TRANSPORT_MODES, TRANSPORT_MODES } = require('./validation');

const rooms = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 8;
const MAX_STORED_MESSAGES = 100;

function generateRoomCode() {
  return Array.from({ length: ROOM_CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

function getUniqueRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error('Не удалось сгенерировать уникальный код комнаты.');
}

function makeParticipant({ socketId, name, role = 'member', joinedAt = Date.now() }) {
  return { id: crypto.randomUUID(), socketId, name, role, joinedAt };
}

function isPrivateRoom(room) {
  return PRIVATE_TRANSPORT_MODES.has(room.transportMode);
}

async function createRoom({ name, pin, maxParticipants, transportMode = TRANSPORT_MODES.GROUP_SERVER, ownerSocketId }) {
  const now = Date.now();
  const code = getUniqueRoomCode();
  const owner = makeParticipant({ socketId: ownerSocketId, name, role: 'owner', joinedAt: now });
  const room = {
    id: crypto.randomUUID(),
    code,
    pinHash: await bcrypt.hash(pin, 12),
    ownerSocketId,
    maxParticipants: isPrivateRoom({ transportMode }) ? 2 : maxParticipants,
    transportMode,
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

function getRoom(code) { return rooms.get(String(code || '').trim().toUpperCase()); }

function addParticipant(room, { id, name }) {
  const participant = makeParticipant({ socketId: id, name, role: room.participants.size === 0 ? 'owner' : 'member' });
  room.participants.set(id, participant);
  if (participant.role === 'owner') room.ownerSocketId = id;
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

function storeMessage(room, message) {
  if (isPrivateRoom(room)) return message;
  room.messages.push(message);
  if (room.messages.length > MAX_STORED_MESSAGES) room.messages.shift();
  room.lastActivityAt = message.createdAt;
  return message;
}

function addSystemMessage(room, text) {
  return storeMessage(room, { id: crypto.randomUUID(), type: 'system', text, createdAt: Date.now() });
}

function addUserMessage(room, { senderId, senderName, text }) {
  return storeMessage(room, { id: crypto.randomUUID(), senderId, senderName, text, createdAt: Date.now(), type: 'user' });
}

function assignNextOwner(room) {
  const nextOwner = Array.from(room.participants.values()).sort((a, b) => a.joinedAt - b.joinedAt)[0];
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
  room.typingSocketIds.clear();
  rooms.delete(room.code);
}

function resetRooms() { Array.from(rooms.values()).forEach(closeRoom); }

function getRoomSnapshot(room, socketId) {
  const self = room.participants.get(socketId);
  return {
    room: {
      code: room.code,
      maxParticipants: room.maxParticipants,
      transportMode: room.transportMode,
      isLocked: room.isLocked,
      createdAt: room.createdAt,
      isOwner: room.ownerSocketId === socketId,
    },
    selfParticipantId: self?.id || null,
    participants: Array.from(room.participants.values()),
    messages: isPrivateRoom(room) ? [] : room.messages.slice(-50),
  };
}

module.exports = { addParticipant, addSystemMessage, addUserMessage, assignNextOwner, clearHistory, closeRoom, createRoom, getRoom, getRoomSnapshot, isPrivateRoom, removeParticipant, resetRooms, rooms };
