const createForm = document.querySelector('#create-room-form');
const joinForm = document.querySelector('#join-room-form');
const createError = document.querySelector('#create-error');
const inviteCard = document.querySelector('#invite-card');
const createdRoomCode = document.querySelector('#created-room-code');
const invitationUrl = document.querySelector('#invitation-url');
const openCreatedRoom = document.querySelector('#open-created-room');
const copyInvitation = document.querySelector('#copy-invitation');
const socket = io();
const SESSION_STORAGE_PREFIX = 'echo-session:';

function saveSession(code, token) {
  if (typeof token !== 'string' || !token) return;
  try {
    window.sessionStorage.setItem(`${SESSION_STORAGE_PREFIX}${code}`, token);
  } catch {
    // The chat still works when browser storage is unavailable.
  }
}

function normaliseName(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function openRoom(code, name) {
  const parameters = new URLSearchParams({ code, name });
  window.location.assign(`/room?${parameters.toString()}`);
}

createForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = normaliseName(createForm.elements.name.value);
  const pin = createForm.elements.pin.value;
  const confirmPin = createForm.elements['confirm-pin'].value;
  const maxParticipants = createForm.elements['max-participants'].value;

  if (!socket.connected) {
    createError.textContent = 'Нет соединения с сервером. Попробуйте ещё раз.';
    return;
  }

  createError.textContent = '';
  socket.emit('create-room', { name, pin, confirmPin, maxParticipants });
});

socket.on('room-created', ({ code, invitationUrl: url, sessionToken }) => {
  saveSession(code, sessionToken);
  createdRoomCode.textContent = code;
  invitationUrl.value = url;
  openCreatedRoom.href = `/room?code=${encodeURIComponent(code)}`;
  inviteCard.hidden = false;
  createForm.reset();
  createForm.elements['max-participants'].value = 10;
  inviteCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

socket.on('room-error', ({ action, message }) => {
  if (action === 'create-room') createError.textContent = message;
});

copyInvitation.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(invitationUrl.value);
    copyInvitation.textContent = 'Скопировано';
    window.setTimeout(() => { copyInvitation.textContent = 'Копировать'; }, 1800);
  } catch {
    invitationUrl.select();
    document.execCommand('copy');
  }
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = joinForm.elements.code.value.trim().toUpperCase();
  const error = document.querySelector('#join-error');

  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)) {
    error.textContent = 'Введите восьмисимвольный код комнаты.';
    return;
  }

  window.location.assign(`/room.html?room=${encodeURIComponent(code)}`);
});
