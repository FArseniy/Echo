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
  messageError.textContent = message;
  showNotice(message);
}

function prepareForRejoin(message) {
  hasJoinedRoom = false;
  needsRejoin = true;
  resumeInFlight = false;
  selfParticipantId = null;
  isCurrentOwner = false;
  typingUsers.clear();
  renderTyping();
  window.clearTimeout(typingTimer);
  isTyping = false;
  messageInput.disabled = true;
  messageButton.disabled = true;
  ownerControls.hidden = true;
  roomLayout.hidden = true;
  joinPanel.hidden = false;
  joinError.textContent = message;
  pinInput.value = '';
}

function returnToHome() {
  socket.disconnect();
  window.location.assign('/');
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!socket.connected) {
    showJoinError('Нет соединения с сервером. Попробуйте ещё раз.');
    return;
  }

  joinError.textContent = '';
  socket.emit('join-room', {
    code: codeInput.value.trim().toUpperCase(),
    name: nameInput.value.trim(),
    pin: pinInput.value,
  });
  pinInput.value = '';
});

socket.on('connect', () => {
  setConnectionState('Подключено', 'is-connected');
  if (!hasJoinedRoom && attemptSessionResume()) {
    if (needsRejoin) joinError.textContent = 'Восстанавливаем соединение…';
    return;
  }
  if (needsRejoin) {
    joinError.textContent = 'Соединение восстановлено. Введите PIN-код ещё раз.';
    pinInput.focus();
  }
});

socket.on('disconnect', () => {
  resumeInFlight = false;
  setConnectionState('Соединение потеряно', 'is-disconnected');
  if (!isLeaving && hasJoinedRoom) {
    prepareForRejoin('Соединение потеряно. После восстановления введите PIN-код ещё раз.');
  }
});

socket.on('connect_error', () => {
  setConnectionState('Не удалось подключиться', 'is-disconnected');
  if (!hasJoinedRoom) joinError.textContent = 'Не удалось подключиться к серверу. Повторяем попытку…';
});

function enterRoom({ room, participants, messages: history, selfParticipantId: selfId, sessionToken }) {
  selfParticipantId = selfId;
  hasJoinedRoom = true;
  needsRejoin = false;
  resumeInFlight = false;
  saveSession(room.code, sessionToken);
  isCurrentOwner = room.isOwner;
  roomCodeElement.textContent = room.code;
  currentUserName.textContent = participants.find((participant) => participant.id === selfId)?.name || 'Вы';
  roomTitleElement.textContent = `Комната ${room.code}`;
  document.title = `Комната ${room.code} · Echo`;
  renderParticipants(participants);
  renderMessages(history);
  joinPanel.hidden = true;
  roomLayout.hidden = false;
  ownerControls.hidden = !isCurrentOwner;
  maxParticipantsInput.value = room.maxParticipants;
  lockRoomButton.textContent = room.isLocked ? 'Разрешить вход' : 'Запретить вход';
  messageInput.disabled = false;
  messageButton.disabled = false;
  messageInput.focus();
}

socket.on('room-joined', enterRoom);
socket.on('session-resumed', enterRoom);

socket.on('session-invalid', ({ message }) => {
  clearSession(requestedCode || codeInput.value);
  resumeInFlight = false;
  if (hasJoinedRoom) {
    prepareForRejoin(message);
    return;
  }
  joinError.textContent = message;
  pinInput.focus();
});

socket.on('room-not-found', ({ message }) => showJoinError(message));
socket.on('invalid-pin', ({ message, attemptsRemaining }) => {
  showJoinError(`${message} Осталось попыток: ${attemptsRemaining}.`);
});
socket.on('too-many-attempts', ({ message, retryAfter }) => {
  const retryTime = retryAfter ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(retryAfter) : null;
  showJoinError(retryTime ? `${message} Повторите после ${retryTime}.` : message);
});
socket.on('room-full', ({ message }) => showJoinError(message));
socket.on('name-taken', ({ message }) => showJoinError(message));
socket.on('chat-error', ({ action, message }) => {
  if (action === 'send-message') showMessageError(message);
  else if (action === 'join-room') showJoinError(message);
  else showMessageError(message);
});
socket.on('participants-updated', renderParticipants);
socket.on('participant-joined', ({ message }) => appendMessage(message));
socket.on('participant-left', ({ participant }) => {
  typingUsers.delete(participant.id);
  renderTyping();
});
socket.on('owner-changed', ({ owner }) => {
  if (owner.id === selfParticipantId) {
    isCurrentOwner = true;
    ownerControls.hidden = false;
    renderParticipants(currentParticipants);
  }
});
socket.on('new-message', appendMessage);
socket.on('users-typing', ({ users = [] }) => {
  typingUsers.clear();
  users.forEach(({ id, name }) => {
    if (id !== selfParticipantId) typingUsers.set(id, name);
  });
  renderTyping();
});
socket.on('chat-cleared', ({ message }) => renderMessages([message]));
socket.on('room-settings-updated', ({ isLocked, maxParticipants }) => {
  maxParticipantsInput.value = maxParticipants;
  lockRoomButton.textContent = isLocked ? 'Разрешить вход' : 'Запретить вход';
});
socket.on('participant-kicked', ({ message }) => {
  isLeaving = true;
  updateTyping(false);
  clearSession(roomCodeElement.textContent);
  messageInput.disabled = true;
  messageButton.disabled = true;
  showMessageError(message);
  window.setTimeout(returnToHome, 1400);
});
socket.on('room-closed', ({ message }) => {
  if (isLeaving) return;
  isLeaving = true;
  updateTyping(false);
  clearSession(roomCodeElement.textContent);
  messageInput.disabled = true;
  messageButton.disabled = true;
  showMessageError(`${message || 'Комната закрыта.'} Вы будете перенаправлены на главную страницу.`);
  window.setTimeout(returnToHome, 1400);
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!socket.connected || messageInput.disabled) return;

  messageError.textContent = '';
  socket.emit('send-message', { text: messageInput.value });
  messageInput.value = '';
  window.clearTimeout(typingTimer);
  updateTyping(false);
});

messageInput.addEventListener('input', () => {
  const hasText = Boolean(messageInput.value.trim());
  updateTyping(hasText);
  window.clearTimeout(typingTimer);
  if (hasText) {
    typingTimer = window.setTimeout(() => updateTyping(false), 1200);
  }
});

copyRoomLinkButton.addEventListener('click', async () => {
  const link = `${window.location.origin}/room.html?room=${encodeURIComponent(roomCodeElement.textContent)}`;
  try {
    await navigator.clipboard.writeText(link);
    copyRoomLinkButton.textContent = '✓';
    showNotice('Ссылка на комнату скопирована.', 'info');
  } catch {
    showNotice('Не удалось скопировать ссылку. Скопируйте её из адресной строки.');
  }
  window.setTimeout(() => { copyRoomLinkButton.textContent = '⧉'; }, 1600);
});

clearHistoryButton.addEventListener('click', () => {
  socket.emit('clear-chat');
});

lockRoomButton.addEventListener('click', () => {
  socket.emit(lockRoomButton.textContent === 'Запретить вход' ? 'lock-room' : 'unlock-room');
});

saveSettingsButton.addEventListener('click', () => {
  socket.emit('update-room-settings', { maxParticipants: maxParticipantsInput.value });
});

closeRoomButton.addEventListener('click', () => {
  if (window.confirm('Закрыть комнату? Сообщения станут недоступны.')) {
    socket.emit('close-room');
  }
});

leaveButton.addEventListener('click', () => {
  if (isLeaving) return;
  isLeaving = true;
  updateTyping(false);
  clearSession(roomCodeElement.textContent);
  messageInput.disabled = true;
  messageButton.disabled = true;

  if (!socket.connected) {
    returnToHome();
    return;
  }

  const fallback = window.setTimeout(returnToHome, 700);
  socket.emit('leave-room', () => {
    window.clearTimeout(fallback);
    returnToHome();
  });
});
