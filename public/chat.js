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
let transportConfig = { enabled: false, iceServers: [] };
let messageSigningKey = null;
const peers = new Map();
const renderedMessageIds = new Set();
const outgoingDeliveries = new Map();

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
const connectionModeTitle = document.querySelector('#connection-mode-title');
const connectionModeDescription = document.querySelector('#connection-mode-description');

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

function closePeer(participantId) {
  const peer = peers.get(participantId);
  if (!peer) return;
  peer.channel?.close();
  peer.connection.close();
  peers.delete(participantId);
}

function closeAllPeers() {
  Array.from(peers.keys()).forEach(closePeer);
  renderTransportMode();
}

function renderTransportMode() {
  const remoteCount = Math.max(0, currentParticipants.length - 1);
  const connectedPeers = Array.from(peers.values()).filter((peer) => peer.channel?.readyState === 'open');
  const directCount = connectedPeers.filter((peer) => peer.route === 'direct').length;
  const turnCount = connectedPeers.filter((peer) => peer.route === 'turn').length;
  const serverCount = Math.max(0, remoteCount - directCount - turnCount);

  if (!hasJoinedRoom || !transportConfig.enabled || !window.RTCPeerConnection || !messageSigningKey) {
    connectionModeTitle.textContent = 'Через сервер';
    connectionModeDescription.textContent = 'Socket.IO: прямой WebRTC-канал недоступен.';
    return;
  }

  if (directCount > 0) {
    connectionModeTitle.textContent = 'P2P напрямую';
  } else if (turnCount > 0) {
    connectionModeTitle.textContent = 'P2P через TURN';
  } else {
    connectionModeTitle.textContent = 'Через сервер';
  }

  connectionModeDescription.textContent = `Прямых: ${directCount} · TURN: ${turnCount} · сервер: ${serverCount}`;
}

function messagePayload(message) {
  return [message.id, message.senderId, message.senderName, String(message.createdAt), message.text].join('\n');
}

function decodeBase64(value) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function configureMessageVerification(transport) {
  transportConfig = transport && typeof transport === 'object' ? transport : { enabled: false, iceServers: [] };
  messageSigningKey = null;

  if (!transportConfig.enabled || !transportConfig.messageSigningPublicKey || !window.crypto?.subtle) {
    renderTransportMode();
    return;
  }

  try {
    messageSigningKey = await window.crypto.subtle.importKey(
      'jwk',
      transportConfig.messageSigningPublicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    transportConfig = { enabled: false, iceServers: [] };
  }

  renderTransportMode();
}

async function verifyDirectMessage(message, signature) {
  if (!messageSigningKey || typeof signature !== 'string' || !message || message.type !== 'user') return false;
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000) return false;

  try {
    return await window.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      messageSigningKey,
      decodeBase64(signature),
      new TextEncoder().encode(messagePayload(message)),
    );
  } catch {
    return false;
  }
}

async function detectPeerRoute(peer) {
  try {
    const stats = await peer.connection.getStats();
    for (const report of stats.values()) {
      if (report.type !== 'candidate-pair' || !(report.selected || report.nominated)) continue;
      const candidate = stats.get(report.localCandidateId);
      peer.route = candidate?.candidateType === 'relay' ? 'turn' : 'direct';
      break;
    }
  } catch {
    peer.route = 'unknown';
  }
  renderTransportMode();
}

function sendPeerPacket(peer, packet) {
  if (peer?.channel?.readyState !== 'open') return false;
  try {
    peer.channel.send(JSON.stringify(packet));
    return true;
  } catch {
    return false;
  }
}

async function handlePeerPacket(peer, rawPacket) {
  if (typeof rawPacket !== 'string' || rawPacket.length > 8_192) return;

  let packet;
  try {
    packet = JSON.parse(rawPacket);
  } catch {
    return;
  }

  if (packet?.type === 'delivery-receipt' && typeof packet.messageId === 'string') {
    markMessageDelivered(packet.messageId, peer.participant.id);
    return;
  }

  if (packet?.type !== 'message' || packet.message?.senderId !== peer.participant.id || packet.message?.senderName !== peer.participant.name) return;
  if (!await verifyDirectMessage(packet.message, packet.signature)) return;

  appendMessage(packet.message);
  sendPeerPacket(peer, { type: 'delivery-receipt', messageId: packet.message.id });
}

function configureDataChannel(peer, channel) {
  peer.channel = channel;
  channel.onopen = () => { detectPeerRoute(peer); };
  channel.onclose = () => { renderTransportMode(); };
  channel.onerror = () => { renderTransportMode(); };
  channel.onmessage = (event) => { handlePeerPacket(peer, event.data); };
}

function createPeer(participant) {
  if (!participant || participant.id === selfParticipantId || peers.has(participant.id)) return peers.get(participant.id) || null;
  if (!transportConfig.enabled || !messageSigningKey || !window.RTCPeerConnection) return null;

  const connection = new RTCPeerConnection({ iceServers: transportConfig.iceServers || [] });
  const peer = {
    participant,
    connection,
    channel: null,
    route: 'unknown',
    makingOffer: false,
    polite: String(selfParticipantId) > String(participant.id),
    pendingCandidates: [],
  };

  connection.onicecandidate = ({ candidate }) => {
    if (!candidate || !hasJoinedRoom) return;
    socket.emit('webrtc-ice-candidate', {
      targetParticipantId: participant.id,
      candidate: candidate.toJSON ? candidate.toJSON() : candidate,
    });
  };
  connection.ondatachannel = ({ channel }) => configureDataChannel(peer, channel);
  connection.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(connection.connectionState)) closePeer(participant.id);
    else renderTransportMode();
  };
  peers.set(participant.id, peer);
  renderTransportMode();
  return peer;
}

async function startOffer(participant) {
  if (!participant || String(selfParticipantId) >= String(participant.id)) return;
  const peer = createPeer(participant);
  if (!peer || peer.connection.signalingState !== 'stable') return;

  try {
    peer.makingOffer = true;
    configureDataChannel(peer, peer.connection.createDataChannel('echo-message'));
    await peer.connection.setLocalDescription(await peer.connection.createOffer());
    socket.emit('webrtc-offer', { targetParticipantId: participant.id, description: peer.connection.localDescription });
  } catch {
    closePeer(participant.id);
  } finally {
    peer.makingOffer = false;
  }
}

function connectToParticipants(participants) {
  participants.forEach(startOffer);
}

async function applyPendingCandidates(peer) {
  while (peer.pendingCandidates.length > 0) {
    const candidate = peer.pendingCandidates.shift();
    try { await peer.connection.addIceCandidate(candidate); } catch { /* The peer will use the server fallback. */ }
  }
}

async function handleWebRtcOffer({ fromParticipantId, description }) {
  const participant = currentParticipants.find((item) => item.id === fromParticipantId);
  if (!participant || !description) return;
  const peer = createPeer(participant);
  if (!peer) return;

  try {
    const collision = peer.makingOffer || peer.connection.signalingState !== 'stable';
    if (collision && !peer.polite) return;
    if (collision) await peer.connection.setLocalDescription({ type: 'rollback' });
    await peer.connection.setRemoteDescription(description);
    await applyPendingCandidates(peer);
    await peer.connection.setLocalDescription(await peer.connection.createAnswer());
    socket.emit('webrtc-answer', { targetParticipantId: participant.id, description: peer.connection.localDescription });
  } catch {
    closePeer(participant.id);
  }
}

async function handleWebRtcAnswer({ fromParticipantId, description }) {
  const peer = peers.get(fromParticipantId);
  if (!peer || !description) return;
  try {
    await peer.connection.setRemoteDescription(description);
    await applyPendingCandidates(peer);
  } catch {
    closePeer(fromParticipantId);
  }
}

async function handleWebRtcCandidate({ fromParticipantId, candidate }) {
  const peer = peers.get(fromParticipantId);
  if (!peer || !candidate) return;
  if (!peer.connection.remoteDescription) {
    peer.pendingCandidates.push(candidate);
    return;
  }
  try { await peer.connection.addIceCandidate(candidate); } catch { /* The peer will use the server fallback. */ }
}

function updateDeliveryStatus(messageId) {
  const state = outgoingDeliveries.get(messageId);
  const status = messages.querySelector(`[data-delivery-for="${messageId}"]`);
  if (!state || !status) return;
  status.textContent = state.expected.size === 0
    ? 'Нет получателей'
    : `Доставлено ${state.delivered.size} из ${state.expected.size}`;
}

function markMessageDelivered(messageId, participantId) {
  const state = outgoingDeliveries.get(messageId);
  if (!state || !state.expected.has(participantId)) return;
  state.delivered.add(participantId);
  if (state.delivered.size === state.expected.size) window.clearTimeout(state.fallbackTimer);
  updateDeliveryStatus(messageId);
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
  renderTransportMode();
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
  if (message?.id && renderedMessageIds.has(message.id)) return null;
  if (message?.id) renderedMessageIds.add(message.id);
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
    if (message.senderId === selfParticipantId) {
      const delivery = document.createElement('span');
      delivery.className = 'delivery-status';
      delivery.dataset.deliveryFor = message.id;
      if (!outgoingDeliveries.has(message.id)) delivery.textContent = 'Доставка не отслеживается';
      item.append(delivery);
      updateDeliveryStatus(message.id);
    }
  } else {
    item.append(text, time);
  }
  messages.append(item);
  if (message.type === 'user' && message.senderId === selfParticipantId) updateDeliveryStatus(message.id);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function renderMessages(history) {
  messages.replaceChildren();
  renderedMessageIds.clear();
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
  closeAllPeers();
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

async function enterRoom({ room, participants, messages: history, selfParticipantId: selfId, sessionToken, transport }) {
  closeAllPeers();
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
  await configureMessageVerification(transport);
  connectToParticipants(participants);
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
socket.on('participant-joined', ({ participant, message }) => {
  appendMessage(message);
  startOffer(participant);
});
socket.on('participant-left', ({ participant }) => {
  typingUsers.delete(participant.id);
  closePeer(participant.id);
  renderTyping();
});
socket.on('participant-reconnected', ({ participant }) => startOffer(participant));
socket.on('owner-changed', ({ owner }) => {
  if (owner.id === selfParticipantId) {
    isCurrentOwner = true;
    ownerControls.hidden = false;
    renderParticipants(currentParticipants);
  }
});
socket.on('new-message', appendMessage);
socket.on('webrtc-offer', handleWebRtcOffer);
socket.on('webrtc-answer', handleWebRtcAnswer);
socket.on('webrtc-ice-candidate', handleWebRtcCandidate);
socket.on('p2p-message-prepared', ({ message, signature }) => {
  if (!message || typeof signature !== 'string') return;
  const expected = new Set(currentParticipants.filter((participant) => participant.id !== selfParticipantId).map((participant) => participant.id));
  const deliveryState = { expected, delivered: new Set(), fallbackTimer: null };
  outgoingDeliveries.set(message.id, deliveryState);
  appendMessage(message);

  const relayTargets = [];
  expected.forEach((participantId) => {
    const peer = peers.get(participantId);
    if (!sendPeerPacket(peer, { type: 'message', message, signature })) relayTargets.push(participantId);
  });
  if (relayTargets.length > 0) socket.emit('p2p-relay-message', { messageId: message.id, targetParticipantIds: relayTargets });
  deliveryState.fallbackTimer = window.setTimeout(() => {
    const undelivered = Array.from(deliveryState.expected).filter((participantId) => !deliveryState.delivered.has(participantId));
    if (undelivered.length > 0) socket.emit('p2p-relay-message', { messageId: message.id, targetParticipantIds: undelivered });
  }, 3500);
  updateDeliveryStatus(message.id);
});
socket.on('p2p-relay-message', ({ message }) => {
  if (!message) return;
  appendMessage(message);
  socket.emit('p2p-delivery-received', { messageId: message.id });
});
socket.on('message-delivery-update', ({ messageId, participantId }) => markMessageDelivered(messageId, participantId));
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
  socket.emit('p2p-prepare-message', { text: messageInput.value });
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
