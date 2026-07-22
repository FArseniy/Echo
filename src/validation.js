const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 24;
const MIN_PARTICIPANTS = 2;
const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const TRANSPORT_MODES = Object.freeze({
  PRIVATE_DIRECT: 'private-direct',
  PRIVATE_TURN: 'private-turn',
  GROUP_SERVER: 'group-server',
});
const PRIVATE_TRANSPORT_MODES = new Set([
  TRANSPORT_MODES.PRIVATE_DIRECT,
  TRANSPORT_MODES.PRIVATE_TURN,
]);
const RESERVED_NAMES = new Set(['admin', 'administrator', 'echo', 'owner', 'system', 'владелец', 'система']);

function readPositiveInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const MAX_PARTICIPANTS = readPositiveInteger('MAX_ROOM_PARTICIPANTS', 20, { min: MIN_PARTICIPANTS, max: 50 });
const MAX_MESSAGE_LENGTH = readPositiveInteger('MAX_MESSAGE_LENGTH', 2000, { min: 1, max: 2000 });

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normaliseName(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
}

function normaliseRoomCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function validateName(value) {
  const name = normaliseName(value);
  const length = Array.from(name).length;
  if (length < MIN_NAME_LENGTH || length > MAX_NAME_LENGTH) {
    return { valid: false, message: `Имя должно содержать от ${MIN_NAME_LENGTH} до ${MAX_NAME_LENGTH} символов.` };
  }
  if (/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/u.test(name)) {
    return { valid: false, message: 'Имя содержит недопустимые символы.' };
  }
  if (RESERVED_NAMES.has(name.toLocaleLowerCase('ru'))) {
    return { valid: false, message: 'Это служебное имя нельзя использовать.' };
  }
  return { valid: true, value: name };
}

function validatePin(value) {
  const pin = typeof value === 'string' ? value : '';
  return /^\d{4,8}$/.test(pin)
    ? { valid: true, value: pin }
    : { valid: false, message: 'PIN должен состоять из 4–8 цифр.' };
}

function validateTransportMode(value) {
  return Object.values(TRANSPORT_MODES).includes(value)
    ? { valid: true, value }
    : { valid: false, message: 'Выберите допустимый режим комнаты.' };
}

function validateMaxParticipants(value) {
  const maxParticipants = Number(value);
  if (!Number.isInteger(maxParticipants) || maxParticipants < MIN_PARTICIPANTS || maxParticipants > MAX_PARTICIPANTS) {
    return { valid: false, message: `Количество участников должно быть от ${MIN_PARTICIPANTS} до ${MAX_PARTICIPANTS}.` };
  }
  return { valid: true, value: maxParticipants };
}

function validateCreateRoom(payload) {
  const input = asObject(payload);
  const nameResult = validateName(input.name);
  const pinResult = validatePin(input.pin);
  const transportResult = validateTransportMode(input.transportMode);
  if (!nameResult.valid) return nameResult;
  if (!pinResult.valid) return pinResult;
  if (pinResult.value !== (typeof input.confirmPin === 'string' ? input.confirmPin : '')) {
    return { valid: false, message: 'PIN и подтверждение PIN не совпадают.' };
  }
  if (!transportResult.valid) return transportResult;
  const maxResult = PRIVATE_TRANSPORT_MODES.has(transportResult.value)
    ? { valid: true, value: 2 }
    : validateMaxParticipants(input.maxParticipants);
  if (!maxResult.valid) return maxResult;
  return {
    valid: true,
    data: { name: nameResult.value, pin: pinResult.value, maxParticipants: maxResult.value, transportMode: transportResult.value },
  };
}

function validateJoinRoom(payload) {
  const input = asObject(payload);
  const code = normaliseRoomCode(input.code);
  const nameResult = validateName(input.name);
  const pinResult = validatePin(input.pin);
  if (!ROOM_CODE_PATTERN.test(code)) return { valid: false, message: 'Код комнаты должен состоять из 8 допустимых символов.' };
  if (!nameResult.valid) return nameResult;
  if (!pinResult.valid) return pinResult;
  return { valid: true, data: { code, name: nameResult.value, pin: pinResult.value } };
}

function validateMessage(payload) {
  const text = typeof asObject(payload).text === 'string' ? asObject(payload).text.trim() : '';
  if (!text) return { valid: false, message: 'Сообщение не может быть пустым.' };
  if (Array.from(text).length > MAX_MESSAGE_LENGTH) return { valid: false, message: `Сообщение не должно быть длиннее ${MAX_MESSAGE_LENGTH} символов.` };
  return { valid: true, data: { text } };
}

module.exports = {
  asObject,
  MAX_MESSAGE_LENGTH,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
  PRIVATE_TRANSPORT_MODES,
  TRANSPORT_MODES,
  normaliseRoomCode,
  validateCreateRoom,
  validateJoinRoom,
  validateMaxParticipants,
  validateMessage,
};
