const createForm = document.querySelector('#create-room-form');
const joinForm = document.querySelector('#join-room-form');
const createError = document.querySelector('#create-error');
const inviteCard = document.querySelector('#invite-card');
const createdRoomCode = document.querySelector('#created-room-code');
const createdRoomMode = document.querySelector('#created-room-mode');
const invitationUrl = document.querySelector('#invitation-url');
const openCreatedRoom = document.querySelector('#open-created-room');
const copyInvitation = document.querySelector('#copy-invitation');
const transportMode = document.querySelector('#create-transport-mode');
const transportHint = document.querySelector('#transport-mode-hint');
const maxParticipants = document.querySelector('#create-max-participants');
const socket = io();
const SESSION_STORAGE_PREFIX = 'echo-session:';
const modeLabels = {
  'private-direct': 'Приватный P2P: прямое соединение без серверной истории.',
  'private-turn': 'Приватный P2P + TURN: текст по-прежнему не проходит через Echo.',
  'group-server': 'Групповой режим: сообщения хранятся в памяти Echo до закрытия комнаты.',
};

function saveSession(code, token) { try { if (token) sessionStorage.setItem(`${SESSION_STORAGE_PREFIX}${code}`, token); } catch {} }
function updateModeUi() {
  const privateRoom = transportMode.value !== 'group-server';
  maxParticipants.disabled = privateRoom;
  maxParticipants.value = privateRoom ? '2' : (maxParticipants.value === '2' ? '10' : maxParticipants.value);
  transportHint.textContent = transportMode.value === 'private-direct'
    ? 'Текст не проходит через Echo: нужен прямой WebRTC-канал. IP может быть виден собеседнику.'
    : transportMode.value === 'private-turn'
      ? 'Сначала используется прямой канал; при необходимости TURN передаёт только зашифрованные данные.'
      : 'Сообщения проходят через Echo, временно хранятся в памяти и получают статус доставки.';
}
transportMode.addEventListener('change', updateModeUi);
updateModeUi();

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!socket.connected) { createError.textContent = 'Нет соединения с сервером. Попробуйте ещё раз.'; return; }
  createError.textContent = '';
  socket.emit('create-room', {
    name: createForm.elements.name.value.trim().replace(/\s+/g, ' '),
    pin: createForm.elements.pin.value,
    confirmPin: createForm.elements['confirm-pin'].value,
    maxParticipants: maxParticipants.value,
    transportMode: transportMode.value,
  });
});
socket.on('room-created', ({ code, invitationUrl: url, sessionToken, transportMode: mode }) => {
  saveSession(code, sessionToken); createdRoomCode.textContent = code; createdRoomMode.textContent = modeLabels[mode] || '';
  invitationUrl.value = url; openCreatedRoom.href = `/room.html?room=${encodeURIComponent(code)}`; inviteCard.hidden = false;
  createForm.reset(); transportMode.value = 'private-direct'; updateModeUi(); inviteCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
socket.on('room-error', ({ action, message }) => { if (action === 'create-room') createError.textContent = message; });
copyInvitation.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(invitationUrl.value); copyInvitation.textContent = 'Скопировано'; }
  catch { invitationUrl.select(); document.execCommand('copy'); }
  setTimeout(() => { copyInvitation.textContent = 'Копировать ссылку'; }, 1800);
});
joinForm.addEventListener('submit', (event) => {
  event.preventDefault(); const code = joinForm.elements.code.value.trim().toUpperCase(); const error = document.querySelector('#join-error');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)) { error.textContent = 'Введите восьмисимвольный код комнаты.'; return; }
  location.assign(`/room.html?room=${encodeURIComponent(code)}`);
});
