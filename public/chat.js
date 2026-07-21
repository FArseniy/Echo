const parameters = new URLSearchParams(window.location.search);
const requestedCode = (parameters.get('room') || parameters.get('code') || '').trim().toUpperCase();
const socket = io();
const SESSION_STORAGE_PREFIX = 'echo-session:';
let selfParticipantId = null;
let hasJoinedRoom = false;
let needsRejoin = false;
let isLeaving = false;
let isCurrentOwner = false;
let currentParticipants = [];
const typingUsers = new Map();
let typingTimer;
let isTyping = false;
let resumeInFlight = false;

const connectionState = document.querySelector('#connection-state');
const joinPanel = document.querySelector('#join-panel');
const joinForm = document.querySelector('#room-join-form');
const joinError = document.querySelector('#join-error');
const codeInput = document.querySelector('#room-code-input');
const nameInput = document.querySelector('#participant-name-input');
const pinInput = document.querySelector('#room-pin-input');
const roomLayout = document.querySelector('#room-layout');
const roomCodeElement = document.querySelector('#room-code');
const roomTitleElement = document.querySelector('#room-title');
const participantCount = document.querySelector('#participant-count');
const participantList = document.querySelector('#participant-list');
const messages = document.querySelector('#messages');
const leaveButton = document.querySelector('#leave-button');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const messageButton = messageForm.querySelector('button');
const messageError = document.querySelector('#message-error');
const ownerControls = document.querySelector('#owner-controls');
const clearHistoryButton = document.querySelector('#clear-history-button');
const closeRoomButton = document.querySelector('#close-room-button');
const lockRoomButton = document.querySelector('#lock-room-button');
const maxParticipantsInput = document.querySelector('#max-participants-input');
const saveSettingsButton = document.querySelector('#save-settings-button');
const copyRoomLinkButton = document.querySelector('#copy-room-link');
const currentUserName = document.querySelector('#current-user-name');
const typingIndicator = document.querySelector('#typing-indicator');
const noticePanel = document.querySelector('#notice-panel');

codeInput.value = requestedCode;

function getSessionKey(code) {
  return `${SESSION_STORAGE_PREFIX}${String(code || '').trim().toUpperCase()}`;
}

function readSession(code) {
  try {
    return window.sessionStorage.getItem(getSessionKey(code));
  } catch {
    return null;
  }
}

function saveSession(code, token) {
  if (typeof token !== 'string' || !token) return;
  try {
    window.sessionStorage.setItem(getSessionKey(code), token);
  } catch {
    // The chat remains usable when browser storage is unavailable.
  }
}

function clearSession(code) {
  try {
    window.sessionStorage.removeItem(getSessionKey(code));
  } catch {
    // No action is needed when browser storage is unavailable.
  }
}

function attemptSessionResume() {
  const code = (requestedCode || codeInput.value).trim().toUpperCase();
  const token = readSession(code);
  if (!code || !token || resumeInFlight || !socket.connected) return false;

  resumeInFlight = true;
  socket.emit('resume-session', { code, token });
  return true;
}

function setConnectionState(text, stateClass) {
  connectionState.className = `connection-state ${stateClass}`;
  connectionState.lastElementChild.textContent = text;
}

function renderParticipants(participants) {
  currentParticipants = participants;
  participantCount.textContent = String(participants.length);
  participantList.replaceChildren();

  participants.forEach((participant) => {
    const item = document.createElement('li');
    const labels = [participant.name];
    if (participant.id === selfParticipantId) {
      item.classList.add('participant-self');
      labels.push('вы');
    }
    if (participant.role === 'owner') labels.push('владелец');
    const label = document.createElement('span');
    label.textContent = labels.join(' · ');
    item.append(label);

    if (isCurrentOwner && participant.id !== selfParticipantId) {
      const kickButton = document.createElement('button');
      kickButton.className = 'kick-button';
      kickButton.type = 'button';
      kickButton.textContent = 'Удалить';
      kickButton.addEventListener('click', () => socket.emit('kick-participant', { participantId: participant.id }));
      item.append(kickButton);
    }
    participantList.append(item);
  });
}

function showNotice(message, type = 'error') {
  noticePanel.textContent = message;
  noticePanel.className = `notice-panel ${type === 'info' ? 'is-info' : ''}`;
  noticePanel.hidden = false;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { noticePanel.hidden = true; }, 5000);
}

function renderTyping() {
  const names = Array.from(typingUsers.values());
  if (names.length === 0) {
    typingIndicator.textContent = '';
  } else if (names.length === 1) {
    typingIndicator.textContent = `${names[0]} печатает…`;
  } else {
    typingIndicator.textContent = names.length === 2
      ? `${names.join(' и ')} печатают…`
      : 'Несколько участников печатают…';
  }
}

function updateTyping(nextState) {
  if (!hasJoinedRoom || isTyping === nextState) return;
  isTyping = nextState;
  socket.emit(nextState ? 'typing-start' : 'typing-stop');
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function appendMessage(message) {
  messages.querySelector('.empty-chat')?.remove();
  const item = document.createElement('article');
  item.className = message.type === 'system' ? 'system-message' : 'chat-message';
  const text = document.createElement('p');
  const time = document.createElement('time');
  text.textContent = message.text;
  time.textContent = formatTime(message.createdAt);

  if (message.type === 'user') {
    if (message.senderId === selfParticipantId) item.classList.add('own');
    const sender = document.createElement('strong');
    sender.textContent = message.senderName;
    item.append(sender, text, time);
  } else {
    item.append(text, time);
  }
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
}

function renderMessages(history) {
  messages.replaceChildren();
  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-chat';
    empty.textContent = 'В комнате пока нет сообщений.';
    messages.append(empty);
    return;
  }
  history.forEach(appendMessage);
}

function showJoinError(message) {
  joinError.textContent = message;
  showNotice(message);
  pinInput.value = '';
  pinInput.focus();
}

function showMessageError(message) {
  me۽<��$z{-���jם};
  }
  return { valid: true, value: maxParticipants };
}

function validateJoinRoom(payload) {
  const input = asObject(payload);
  const code = normaliseRoomCode(input.code);
  const nameResult = validateName(input.name);
  const pinResult = validatePin(input.pin);

  if (!ROOM_CODE_PATTERN.test(code)) {
    return { valid: false, message: 'Код комнаты должен состоять из 8 допустимых символов.' };
  }

  if (!nameResult.valid) return nameResult;
  if (!pinResult.valid) return pinResult;

  return { valid: true, data: { code, name: nameResult.value, pin: pinResult.value } };
}

function validateMessage(payload) {
  const input = asObject(payload);
  const text = typeof input.text === 'string' ? input.text.trim() : '';

  if (!text) return { valid: false, message: 'Сообщение не может быть пустым.' };
  if (Array.from(text).length > MAX_MESSAGE_LENGTH) {
    return { valid: false, message: `Сообщение не должно быть длиннее ${MAX_MESSAGE_LENGTH} символов.` };
  }

  return { valid: true, data: { text } };
}

module.exports = {
  asObject,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
  normaliseRoomCode,
  validateCreateRoom,
  validateJoinRoom,
  validateMaxParticipants,
  validateMessage,
};
