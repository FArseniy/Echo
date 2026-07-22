const parameters = new URLSearchParams(location.search);
const requestedCode = (parameters.get('room') || parameters.get('code') || '').trim().toUpperCase();
const socket = io();
const SESSION_STORAGE_PREFIX = 'echo-session:';
const PRIVATE_MODES = new Set(['private-direct', 'private-turn']);
const MAX_P2P_PACKET_CHARS = 16_384;
let selfParticipantId = null;
let hasJoinedRoom = false;
let needsRejoin = false;
let isLeaving = false;
let isCurrentOwner = false;
let currentRoom = null;
let currentParticipants = [];
let typingTimer;
let isTyping = false;
let resumeInFlight = false;
let transportConfig = { mode: 'group-server', enabled: false, iceServers: [] };
let e2ee = null;
const peers = new Map();
const typingUsers = new Map();
const renderedMessageIds = new Set();
const outgoingDeliveries = new Map();
const localMessageTimes = [];

const $ = (selector) => document.querySelector(selector);
const connectionState = $('#connection-state'); const joinPanel = $('#join-panel'); const joinForm = $('#room-join-form'); const joinError = $('#join-error');
const codeInput = $('#room-code-input'); const nameInput = $('#participant-name-input'); const pinInput = $('#room-pin-input'); const roomLayout = $('#room-layout');
const roomCodeElement = $('#room-code'); const roomTitleElement = $('#room-title'); const participantCount = $('#participant-count'); const participantList = $('#participant-list');
const messages = $('#messages'); const leaveButton = $('#leave-button'); const messageForm = $('#message-form'); const messageInput = $('#message-input'); const messageButton = messageForm.querySelector('button'); const messageError = $('#message-error');
const ownerControls = $('#owner-controls'); const clearHistoryButton = $('#clear-history-button'); const closeRoomButton = $('#close-room-button'); const lockRoomButton = $('#lock-room-button'); const maxParticipantsInput = $('#max-participants-input'); const limitControl = $('#limit-control'); const saveSettingsButton = $('#save-settings-button');
const copyRoomLinkButton = $('#copy-room-link'); const currentUserName = $('#current-user-name'); const typingIndicator = $('#typing-indicator'); const noticePanel = $('#notice-panel'); const connectionModeTitle = $('#connection-mode-title'); const connectionModeDescription = $('#connection-mode-description'); const safetyCodeElement = $('#safety-code');
codeInput.value = requestedCode;

function sessionKey(code) { return `${SESSION_STORAGE_PREFIX}${String(code || '').trim().toUpperCase()}`; }
function readSession(code) { try { return sessionStorage.getItem(sessionKey(code)); } catch { return null; } }
function saveSession(code, token) { try { if (token) sessionStorage.setItem(sessionKey(code), token); } catch {} }
function clearSession(code) { try { sessionStorage.removeItem(sessionKey(code)); } catch {} }
function isPrivateRoom() { return PRIVATE_MODES.has(currentRoom?.transportMode); }
function setConnectionState(text, stateClass) { connectionState.className = `connection-state ${stateClass}`; connectionState.lastElementChild.textContent = text; }
function showNotice(message, type = 'error') { noticePanel.textContent = message; noticePanel.className = `notice-panel ${type === 'info' ? 'is-info' : ''}`; noticePanel.hidden = false; clearTimeout(showNotice.timer); showNotice.timer = setTimeout(() => { noticePanel.hidden = true; }, 5_000); }
function showMessageError(message) { messageError.textContent = message; showNotice(message); }
function attemptSessionResume() { const code = (requestedCode || codeInput.value).trim().toUpperCase(); const token = readSession(code); if (!code || !token || resumeInFlight || !socket.connected) return false; resumeInFlight = true; socket.emit('resume-session', { code, token }); return true; }
function bytesToBase64(bytes) { let binary = ''; bytes.forEach((value) => { binary += String.fromCharCode(value); }); return btoa(binary); }
function base64ToBytes(value) { try { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); } catch { return null; } }
function metadata(packet) { return JSON.stringify([packet.id, packet.senderId, packet.senderName, packet.createdAt]); }

function closePeer(id) { const peer = peers.get(id); if (!peer) return; peer.channel?.close(); peer.connection.close(); peers.delete(id); renderTransportMode(); }
function closeAllPeers() { Array.from(peers.keys()).forEach(closePeer); }
function peerForRemote() { return Array.from(peers.values()).find((peer) => peer.channel?.readyState === 'open' && peer.sharedKey); }
function renderTransportMode() {
  if (!hasJoinedRoom) return;
  if (!isPrivateRoom()) { connectionModeTitle.textContent = 'Через сервер'; connectionModeDescription.textContent = 'Socket.IO: временная история и подтверждение доставки через Echo.'; safetyCodeElement.hidden = true; return; }
  const peer = peerForRemote();
  if (!transportConfig.enabled || !window.RTCPeerConnection) { connectionModeTitle.textContent = 'P2P недоступен'; connectionModeDescription.textContent = 'В этой приватной комнате сервер не передаёт текст. Проверьте поддержку WebRTC.'; safetyCodeElement.hidden = true; return; }
  if (!peer) { connectionModeTitle.textContent = 'Подключение P2P…'; connectionModeDescription.textContent = 'Echo передаёт только служебные сигналы; текст не отправляется через сервер.'; safetyCodeElement.hidden = true; return; }
  connectionModeTitle.textContent = peer.route === 'turn' ? 'P2P через TURN' : 'P2P напрямую';
  connectionModeDescription.textContent = peer.route === 'turn' ? 'TURN передаёт только зашифрованные WebRTC-данные.' : 'Текст идёт напрямую между устройствами и не сохраняется.';
  safetyCodeElement.hidden = !peer.safetyCode;
  safetyCodeElement.textContent = peer.safetyCode ? `Код проверки: ${peer.safetyCode}. Сверьте его с собеседником вне чата.` : '';
}
function renderTyping() { const names = Array.from(typingUsers.values()); typingIndicator.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} печатает…` : names.length === 2 ? `${names.join(' и ')} печатают…` : 'Несколько участников печатают…'; }
function updateTyping(nextState) {
  if (!hasJoinedRoom || isTyping === nextState) return;
  isTyping = nextState;
  if (isPrivateRoom()) { const peer = peerForRemote(); if (peer) sendPeerPacket(peer, { type: 'typing', active: nextState }); }
  else socket.emit(nextState ? 'typing-start' : 'typing-stop');
}
function formatTime(timestamp) { return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(timestamp); }
function updateDeliveryStatus(id) { const state = outgoingDeliveries.get(id); const status = messages.querySelector(`[data-delivery-for="${CSS.escape(id)}"]`); if (!state || !status) return; const total = state.expected.size; const delivered = state.delivered.size; status.textContent = delivered ? (delivered === total ? '✓✓' : `✓✓ ${delivered}/${total}`) : '✓'; status.setAttribute('aria-label', delivered === total ? 'Доставлено' : delivered ? `Доставлено ${delivered} из ${total}` : 'Отправлено'); }
function markMessageDelivered(id, participantId) { const state = outgoingDeliveries.get(id); if (!state || !state.expected.has(participantId)) return; state.delivered.add(participantId); updateDeliveryStatus(id); }
function appendMessage(message) {
  if (!message?.id || renderedMessageIds.has(message.id)) return; renderedMessageIds.add(message.id); messages.querySelector('.empty-chat')?.remove();
  const item = document.createElement('article'); item.className = message.type === 'system' ? 'system-message' : 'chat-message'; const text = document.createElement('p'); const time = document.createElement('time'); text.textContent = message.text; time.textContent = formatTime(message.createdAt);
  if (message.type === 'user') { if (message.senderId === selfParticipantId) item.classList.add('own'); const sender = document.createElement('strong'); sender.textContent = message.senderName; item.append(sender, text, time); if (message.senderId === selfParticipantId) { const delivery = document.createElement('span'); delivery.className = 'delivery-status'; delivery.dataset.deliveryFor = message.id; item.append(delivery); updateDeliveryStatus(message.id); } }
  else item.append(text, time);
  messages.append(item); messages.scrollTop = messages.scrollHeight;
}
function renderMessages(history) { messages.replaceChildren(); renderedMessageIds.clear(); if (!history.length) { const empty = document.createElement('div'); empty.className = 'empty-chat'; empty.textContent = isPrivateRoom() ? 'В приватной P2P-комнате история не хранится.' : 'В комнате пока нет сообщений.'; messages.append(empty); return; } history.forEach(appendMessage); }
function renderParticipants(participants) {
  currentParticipants = participants; participantCount.textContent = String(participants.length); participantList.replaceChildren();
  participants.forEach((participant) => { const item = document.createElement('li'); const label = document.createElement('span'); const labels = [participant.name]; if (participant.id === selfParticipantId) { item.classList.add('participant-self'); labels.push('вы'); } if (participant.role === 'owner') labels.push('владелец'); label.textContent = labels.join(' · '); item.append(label); if (isCurrentOwner && participant.id !== selfParticipantId) { const button = document.createElement('button'); button.className = 'kick-button'; button.type = 'button'; button.textContent = 'Удалить'; button.addEventListener('click', () => socket.emit('kick-participant', { participantId: participant.id })); item.append(button); } participantList.append(item); });
  renderTransportMode();
}

function concatenateBytes(...parts) { const size = parts.reduce((sum, part) => sum + part.length, 0); const result = new Uint8Array(size); let offset = 0; parts.forEach((part) => { result.set(part, offset); offset += part.length; }); return result; }
async function prepareE2ee(mode) {
  e2ee = null;
  if (!PRIVATE_MODES.has(mode)) return true;
  if (!window.crypto?.subtle) return false;
  try { const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)); e2ee = { publicKey, privateKey: keyPair.privateKey }; return true; } catch { return false; }
}
async function derivePeerKey(peer, publicKey) {
  if (!e2ee || publicKey.length !== 65) return false;
  try { const publicKeyObject = await crypto.subtle.importKey('raw', publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []); const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKeyObject }, e2ee.privateKey, 256); peer.sharedKey = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); const ordered = [e2ee.publicKey, publicKey].sort((a, b) => bytesToBase64(a).localeCompare(bytesToBase64(b))); const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256', concatenateBytes(ordered[0], ordered[1]))).slice(0, 6); peer.safetyCode = Array.from(fingerprint).map((byte) => String(byte % 100).padStart(2, '0')).join('').replace(/(\d{3})(?=\d)/g, '$1 '); renderTransportMode(); return true; } catch { return false; }
}
function sendPeerPacket(peer, packet) { if (peer?.channel?.readyState !== 'open') return false; try { peer.channel.send(JSON.stringify(packet)); return true; } catch { return false; } }
async function encryptForPeer(peer, message) { const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(metadata(message)) }, peer.sharedKey, new TextEncoder().encode(message.text)); return { type: 'private-message', id: message.id, senderId: message.senderId, senderName: message.senderName, createdAt: message.createdAt, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) }; }
async function decryptFromPeer(peer, packet) { const iv = base64ToBytes(packet.iv); const ciphertext = base64ToBytes(packet.ciphertext); if (!iv || !ciphertext || iv.length !== 12) return null; try { const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(metadata(packet)) }, peer.sharedKey, ciphertext); return new TextDecoder().decode(plaintext); } catch { return null; } }
async function acceptIncomingPeerMessage(peer, packet) { if (packet.senderId !== peer.participant.id || packet.senderName !== peer.participant.name || typeof packet.id !== 'string' || typeof packet.createdAt !== 'number') return; const text = await decryptFromPeer(peer, packet); if (!text || Array.from(text).length > 2000) return; appendMessage({ id: packet.id, senderId: packet.senderId, senderName: packet.senderName, createdAt: packet.createdAt, text, type: 'user' }); sendPeerPacket(peer, { type: 'delivery-receipt', messageId: packet.id }); }
async function handlePeerPacket(peer, rawPacket) {
  if (typeof rawPacket !== 'string' || rawPacket.length > MAX_P2P_PACKET_CHARS) return; let packet; try { packet = JSON.parse(rawPacket); } catch { return; }
  if (packet.type === 'e2ee-hello' && typeof packet.publicKey === 'string') { const key = base64ToBytes(packet.publicKey); if (key && await derivePeerKey(peer, key)) return; }
  if (packet.type === 'private-message' && peer.sharedKey) await acceptIncomingPeerMessage(peer, packet);
  if (packet.type === 'delivery-receipt' && typeof packet.messageId === 'string') markMessageDelivered(packet.messageId, peer.participant.id);
  if (packet.type === 'typing' && typeof packet.active === 'boolean') { if (packet.active) typingUsers.set(peer.participant.id, peer.participant.name); else typingUsers.delete(peer.participant.id); renderTyping(); }
}
function configureDataChannel(peer, channel) { peer.channel = channel; channel.onopen = () => { sendPeerPacket(peer, { type: 'e2ee-hello', publicKey: bytesToBase64(e2ee.publicKey) }); detectPeerRoute(peer); }; channel.onclose = () => renderTransportMode(); channel.onerror = () => renderTransportMode(); channel.onmessage = (event) => { void handlePeerPacket(peer, event.data); }; }
async function detectPeerRoute(peer) { try { const stats = await peer.connection.getStats(); for (const report of stats.values()) if (report.type === 'candidate-pair' && (report.selected || report.nominated)) { const candidate = stats.get(report.localCandidateId); peer.route = candidate?.candidateType === 'relay' ? 'turn' : 'direct'; break; } } catch {} renderTransportMode(); }
function createPeer(participant) {
  if (!participant || participant.id === selfParticipantId || peers.has(participant.id) || !transportConfig.enabled || !e2ee || !window.RTCPeerConnection) return peers.get(participant?.id) || null;
  const connection = new RTCPeerConnection({ iceServers: transportConfig.iceServers || [] }); const peer = { participant, connection, channel: null, route: 'unknown', makingOffer: false, polite: String(selfParticipantId) > String(participant.id), pendingCandidates: [], sharedKey: null, safetyCode: null };
  connection.onicecandidate = ({ candidate }) => { if (candidate && hasJoinedRoom) socket.emit('webrtc-ice-candidate', { targetParticipantId: participant.id, candidate: candidate.toJSON?.() || candidate }); };
  connection.ondatachannel = ({ channel }) => configureDataChannel(peer, channel); connection.onconnectionstatechange = () => { if (['failed', 'closed'].includes(connection.connectionState)) closePeer(participant.id); else renderTransportMode(); }; peers.set(participant.id, peer); return peer;
}
async function startOffer(participant) { if (!isPrivateRoom() || String(selfParticipantId) >= String(participant?.id)) return; const peer = createPeer(participant); if (!peer || peer.connection.signalingState !== 'stable') return; try { peer.makingOffer = true; configureDataChannel(peer, peer.connection.createDataChannel('echo-private')); await peer.connection.setLocalDescription(await peer.connection.createOffer()); socket.emit('webrtc-offer', { targetParticipantId: participant.id, description: peer.connection.localDescription }); } catch { closePeer(participant.id); } finally { peer.makingOffer = false; } }
async function applyPendingCandidates(peer) { while (peer.pendingCandidates.length) { try { await peer.connection.addIceCandidate(peer.pendingCandidates.shift()); } catch {} } }
async function handleOffer({ fromParticipantId, description }) { const participant = currentParticipants.find((p) => p.id === fromParticipantId); const peer = createPeer(participant); if (!peer || !description) return; try { const collision = peer.makingOffer || peer.connection.signalingState !== 'stable'; if (collision && !peer.polite) return; if (collision) await peer.connection.setLocalDescription({ type: 'rollback' }); await peer.connection.setRemoteDescription(description); await applyPendingCandidates(peer); await peer.connection.setLocalDescription(await peer.connection.createAnswer()); socket.emit('webrtc-answer', { targetParticipantId: participant.id, description: peer.connection.localDescription }); } catch { closePeer(participant.id); } }
async function handleAnswer({ fromParticipantId, description }) { const peer = peers.get(fromParticipantId); if (!peer || !description) return; try { await peer.connection.setRemoteDescription(description); await applyPendingCandidates(peer); } catch { closePeer(fromParticipantId); } }
async function handleCandidate({ fromParticipantId, candidate }) { const peer = peers.get(fromParticipantId); if (!peer || !candidate) return; if (!peer.connection.remoteDescription) { peer.pendingCandidates.push(candidate); return; } try { await peer.connection.addIceCandidate(candidate); } catch {} }
function consumeLocalMessageBudget() { const now = Date.now(); while (localMessageTimes[0] && now - localMessageTimes[0] > 3000) localMessageTimes.shift(); if (localMessageTimes.length >= 5) return false; localMessageTimes.push(now); return true; }

async function enterRoom({ room, participants, messages: history, selfParticipantId: selfId, sessionToken, transport }) {
  closeAllPeers(); typingUsers.clear(); selfParticipantId = selfId; currentRoom = room; hasJoinedRoom = true; needsRejoin = false; resumeInFlight = false; isCurrentOwner = room.isOwner; saveSession(room.code, sessionToken);
  roomCodeElement.textContent = room.code; currentUserName.textContent = participants.find((p) => p.id === selfId)?.name || 'Вы'; roomTitleElement.textContent = `Комната ${room.code}`; document.title = `Комната ${room.code} · Echo`; transportConfig = transport || { mode: room.transportMode, enabled: false, iceServers: [] };
  const encryptionReady = await prepareE2ee(room.transportMode); renderParticipants(participants); renderMessages(history); joinPanel.hidden = true; roomLayout.hidden = false; ownerControls.hidden = !isCurrentOwner; maxParticipantsInput.value = room.maxParticipants; lockRoomButton.textContent = room.isLocked ? 'Разрешить вход' : 'Запретить вход';
  const privateRoom = isPrivateRoom(); clearHistoryButton.hidden = privateRoom; limitControl.hidden = privateRoom; saveSettingsButton.hidden = privateRoom; messageInput.disabled = privateRoom && !encryptionReady; messageButton.disabled = messageInput.disabled; if (privateRoom && !encryptionReady) showMessageError('Не удалось инициализировать криптографию браузера. Приватные сообщения заблокированы.'); messageInput.focus(); renderTransportMode(); if (privateRoom) participants.forEach(startOffer);
}
function prepareForRejoin(message) { hasJoinedRoom = false; needsRejoin = true; resumeInFlight = false; selfParticipantId = null; currentRoom = null; isCurrentOwner = false; e2ee = null; closeAllPeers(); typingUsers.clear(); renderTyping(); clearTimeout(typingTimer); isTyping = false; messageInput.disabled = true; messageButton.disabled = true; ownerControls.hidden = true; roomLayout.hidden = true; joinPanel.hidden = false; joinError.textContent = message; pinInput.value = ''; }
function returnToHome() { socket.disconnect(); location.assign('/'); }

joinForm.addEventListener('submit', (event) => { event.preventDefault(); if (!socket.connected) return showMessageError('Нет соединения с сервером.'); joinError.textContent = ''; socket.emit('join-room', { code: codeInput.value.trim().toUpperCase(), name: nameInput.value.trim(), pin: pinInput.value }); pinInput.value = ''; });
socket.on('connect', () => { setConnectionState('Подключено', 'is-connected'); if (!hasJoinedRoom && attemptSessionResume()) return; if (needsRejoin) { joinError.textContent = 'Соединение восстановлено. Введите PIN-код ещё раз.'; pinInput.focus(); } });
socket.on('disconnect', () => { resumeInFlight = false; setConnectionState('Соединение потеряно', 'is-disconnected'); if (!isLeaving && hasJoinedRoom) prepareForRejoin('Соединение потеряно. Восстанавливаем участие…'); });
socket.on('connect_error', () => { setConnectionState('Не удалось подключиться', 'is-disconnected'); if (!hasJoinedRoom) joinError.textContent = 'Не удалось подключиться к серверу. Повторяем попытку…'; });
socket.on('room-joined', enterRoom); socket.on('session-resumed', enterRoom);
socket.on('session-invalid', ({ message }) => { clearSession(requestedCode || codeInput.value); resumeInFlight = false; if (hasJoinedRoom) prepareForRejoin(message); else { joinError.textContent = message; pinInput.focus(); } });
socket.on('room-not-found', ({ message }) => { joinError.textContent = message; }); socket.on('invalid-pin', ({ message, attemptsRemaining }) => { joinError.textContent = `${message} Осталось попыток: ${attemptsRemaining}.`; pinInput.focus(); }); socket.on('too-many-attempts', ({ message }) => { joinError.textContent = message; }); socket.on('room-full', ({ message }) => { joinError.textContent = message; }); socket.on('name-taken', ({ message }) => { joinError.textContent = message; });
socket.on('chat-error', ({ action, message }) => { if (action === 'join-room') joinError.textContent = message; else showMessageError(message); });
socket.on('participants-updated', renderParticipants); socket.on('participant-joined', ({ participant }) => { if (isPrivateRoom()) showNotice(`${participant.name} подключился к защищённой комнате.`, 'info'); startOffer(participant); }); socket.on('participant-left', ({ participant }) => { typingUsers.delete(participant.id); closePeer(participant.id); renderTyping(); if (isPrivateRoom()) showNotice(`${participant.name} вышел из комнаты.`, 'info'); }); socket.on('participant-reconnected', ({ participant }) => startOffer(participant)); socket.on('owner-changed', ({ owner }) => { if (owner.id === selfParticipantId) { isCurrentOwner = true; ownerControls.hidden = false; renderParticipants(currentParticipants); } });
socket.on('new-message', (message) => { appendMessage(message); if (message.type === 'user' && message.senderId !== selfParticipantId) socket.emit('message-delivery-received', { messageId: message.id }); }); socket.on('message-delivery-expected', ({ messageId, participantIds = [] }) => { outgoingDeliveries.set(messageId, { expected: new Set(participantIds), delivered: new Set() }); updateDeliveryStatus(messageId); }); socket.on('message-delivery-update', ({ messageId, participantId }) => markMessageDelivered(messageId, participantId));
socket.on('webrtc-offer', handleOffer); socket.on('webrtc-answer', handleAnswer); socket.on('webrtc-ice-candidate', handleCandidate); socket.on('users-typing', ({ users = [] }) => { typingUsers.clear(); users.forEach(({ id, name }) => { if (id !== selfParticipantId) typingUsers.set(id, name); }); renderTyping(); }); socket.on('chat-cleared', ({ message }) => renderMessages([message])); socket.on('room-settings-updated', ({ isLocked, maxParticipants }) => { maxParticipantsInput.value = maxParticipants; lockRoomButton.textContent = isLocked ? 'Разрешить вход' : 'Запретить вход'; });
socket.on('participant-kicked', ({ message }) => { isLeaving = true; clearSession(roomCodeElement.textContent); showMessageError(message); setTimeout(returnToHome, 1400); }); socket.on('room-closed', ({ message }) => { if (isLeaving) return; isLeaving = true; clearSession(roomCodeElement.textContent); showMessageError(`${message || 'Комната закрыта.'} Вы будете перенаправлены на главную страницу.`); setTimeout(returnToHome, 1400); });

messageForm.addEventListener('submit', async (event) => { event.preventDefault(); const text = messageInput.value.trim(); if (!text || messageInput.disabled) return; if (Array.from(text).length > 2000) return showMessageError('Сообщение не должно быть длиннее 2 000 символов.'); if (!consumeLocalMessageBudget()) return showMessageError('Слишком много сообщений. Подождите несколько секунд.'); messageError.textContent = ''; messageInput.value = ''; clearTimeout(typingTimer); updateTyping(false);
  if (!isPrivateRoom()) { socket.emit('send-message', { text }); return; }
  const peer = peerForRemote(); if (!peer) return showMessageError('Защищённый P2P-канал ещё не установлен.'); const message = { id: crypto.randomUUID(), senderId: selfParticipantId, senderName: currentParticipants.find((p) => p.id === selfParticipantId)?.name || 'Вы', text, createdAt: Date.now(), type: 'user' }; const packet = await encryptForPeer(peer, message); if (!sendPeerPacket(peer, packet)) return showMessageError('Не удалось отправить сообщение по P2P-каналу.'); outgoingDeliveries.set(message.id, { expected: new Set([peer.participant.id]), delivered: new Set() }); appendMessage(message);
});
messageInput.addEventListener('input', () => { const hasText = Boolean(messageInput.value.trim()); updateTyping(hasText); clearTimeout(typingTimer); if (hasText) typingTimer = setTimeout(() => updateTyping(false), 1200); });
copyRoomLinkButton.addEventListener('click', async () => { const link = `${location.origin}/room.html?room=${encodeURIComponent(roomCodeElement.textContent)}`; try { await navigator.clipboard.writeText(link); copyRoomLinkButton.textContent = '✓'; showNotice('Ссылка на комнату скопирована.', 'info'); } catch { showNotice('Не удалось скопировать ссылку.'); } setTimeout(() => { copyRoomLinkButton.textContent = '⧉'; }, 1600); });
clearHistoryButton.addEventListener('click', () => socket.emit('clear-chat')); lockRoomButton.addEventListener('click', () => socket.emit(lockRoomButton.textContent === 'Запретить вход' ? 'lock-room' : 'unlock-room')); saveSettingsButton.addEventListener('click', () => socket.emit('update-room-settings', { maxParticipants: maxParticipantsInput.value })); closeRoomButton.addEventListener('click', () => { if (confirm('Закрыть комнату? Сообщения станут недоступны.')) socket.emit('close-room'); }); leaveButton.addEventListener('click', () => { if (isLeaving) return; isLeaving = true; clearSession(roomCodeElement.textContent); if (!socket.connected) return returnToHome(); const fallback = setTimeout(returnToHome, 700); socket.emit('leave-room', () => { clearTimeout(fallback); returnToHome(); }); });
