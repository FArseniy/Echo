const bcrypt = require('bcrypt');
const request = require('supertest');
const { createEchoServer } = require('../server');
const { resetLimiters } = require('../src/limits');
const { getRoom, resetRooms } = require('../src/rooms');
const { resetSessions } = require('../src/sessions');
const { resetSocketState } = require('../src/socketHandlers');
const {
  TEST_ORIGIN,
  connectSocket,
  emitAndWait,
  expectNoEvent,
  pause,
  waitForEvent,
} = require('./helpers');

const PIN = '2468';
let echo;
let baseUrl;
let sockets;

function resetState() {
  resetRooms();
  resetSessions();
  resetLimiters();
  resetSocketState();
}

async function openSocket() {
  const socket = await connectSocket(baseUrl);
  sockets.push(socket);
  return socket;
}

async function createRoom(owner, { name = 'Creator', pin = PIN, maxParticipants = 4 } = {}) {
  return emitAndWait(owner, 'create-room', {
    name,
    pin,
    confirmPin: pin,
    maxParticipants,
    // Group mode is the server-backed mode these integration tests exercise.
    // The browser always supplies it from the creation form as well.
    transportMode: 'group-server',
  }, 'room-created');
}

async function joinRoom(socket, { code, name = 'Guest', pin = PIN }) {
  return emitAndWait(socket, 'join-room', { code, name, pin }, 'room-joined');
}

beforeEach(async () => {
  resetState();
  echo = createEchoServer({ publicUrl: TEST_ORIGIN, allowedOrigin: TEST_ORIGIN });
  const address = await echo.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
  sockets = [];
});

afterEach(async () => {
  sockets.forEach((socket) => socket.disconnect());
  await echo.close();
  resetState();
});

it('returns a minimal health-check response', async () => {
  await request(echo.app).get('/healthz').expect(200, { status: 'ok' });
});

describe('Echo: комнаты и вход', () => {
  it('создаёт комнату, генерирует уникальный код и хранит PIN только в хеше', async () => {
    const firstOwner = await openSocket();
    const secondOwner = await openSocket();
    const first = await createRoom(firstOwner, { name: 'Alice' });
    const second = await createRoom(secondOwner, { name: 'Bob' });
    const room = getRoom(first.code);

    expect(first.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(second.code).not.toBe(first.code);
    expect(room.pinHash).not.toBe(PIN);
    await expect(bcrypt.compare(PIN, room.pinHash)).resolves.toBe(true);
    expect(room.participants.get(firstOwner.id)).toMatchObject({ name: 'Alice', role: 'owner' });
  });

  it('открывает страницу комнаты по ссылке и принимает код в любом регистре', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();

    await request(echo.app).get(`/room.html?room=${created.code}`).expect(200);
    const joined = await joinRoom(guest, { code: created.code.toLowerCase(), name: 'LinkGuest' });

    expect(joined.room.code).toBe(created.code);
    expect(joined.participants).toHaveLength(2);
  });

  it('пускает с правильным PIN и отклоняет неправильный', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const wrongGuest = await openSocket();
    const validGuest = await openSocket();

    const rejected = await emitAndWait(wrongGuest, 'join-room', { code: created.code, name: 'WrongPin', pin: '1111' }, 'invalid-pin');
    const joined = await joinRoom(validGuest, { code: created.code, name: 'RightPin' });

    expect(rejected.message).toBeTruthy();
    expect(joined.selfParticipantId).toBeTruthy();
  });

  it('блокирует PIN после пяти неверных попыток с одного IP', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await emitAndWait(guest, 'join-room', { code: created.code, name: 'PinBlock', pin: '1111' }, 'invalid-pin');
    }
    const blocked = await emitAndWait(guest, 'join-room', { code: created.code, name: 'PinBlock', pin: '1111' }, 'too-many-attempts');

    expect(blocked.retryAfter).toBeGreaterThan(Date.now());
  });

  it('не допускает переполнения и повторного имени без учёта регистра', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner, { maxParticipants: 3 });
    const firstGuest = await openSocket();
    const duplicateGuest = await openSocket();
    const secondGuest = await openSocket();
    const overflowGuest = await openSocket();

    await joinRoom(firstGuest, { code: created.code, name: 'Анна' });
    await emitAndWait(duplicateGuest, 'join-room', { code: created.code, name: 'анна', pin: PIN }, 'name-taken');
    await joinRoom(secondGuest, { code: created.code, name: 'Boris' });
    await emitAndWait(overflowGuest, 'join-room', { code: created.code, name: 'Clara', pin: PIN }, 'room-full');
  });
});

describe('Echo: сообщения и участники', () => {
  it('отправляет сообщение только участникам нужной комнаты и не доверяет имени клиента', async () => {
    const ownerOne = await openSocket();
    const ownerTwo = await openSocket();
    const firstRoom = await createRoom(ownerOne, { name: 'RoomOne' });
    const secondRoom = await createRoom(ownerTwo, { name: 'RoomTwo' });
    const guest = await openSocket();
    await joinRoom(guest, { code: firstRoom.code, name: 'Alice' });

    const noForeignMessage = expectNoEvent(guest, 'new-message');
    ownerTwo.emit('send-message', { text: 'Only second room' });
    await noForeignMessage;

    const received = waitForEvent(guest, 'new-message');
    ownerOne.emit('send-message', { text: 'Hello', senderName: 'Forged' });
    const message = await received;

    expect(message).toMatchObject({ text: 'Hello', senderName: 'RoomOne', type: 'user' });
    expect(secondRoom.code).not.toBe(firstRoom.code);
  });

  it('запрещает сообщения без входа, пустые и длиннее 2 000 символов', async () => {
    const anonymous = await openSocket();
    const owner = await openSocket();
    const created = await createRoom(owner);

    await emitAndWait(anonymous, 'send-message', { text: 'No room' }, 'chat-error');
    await emitAndWait(owner, 'send-message', { text: '   ' }, 'chat-error');
    const longError = await emitAndWait(owner, 'send-message', { text: 'x'.repeat(2001), room: created.code }, 'chat-error');

    expect(longError.action).toBe('send-message');
  });

  it('ограничивает спам сообщениями', async () => {
    const owner = await openSocket();
    await createRoom(owner);

    for (let index = 0; index < 5; index += 1) {
      const sent = waitForEvent(owner, 'new-message');
      owner.emit('send-message', { text: `message-${index}` });
      await sent;
    }
    const limited = await emitAndWait(owner, 'send-message', { text: 'message-6' }, 'chat-error');

    expect(limited.code).toBe('message-rate-limit');
  });

  it('обновляет список участников при входе и отключении', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();

    const updatedOnJoin = waitForEvent(owner, 'participants-updated');
    await joinRoom(guest, { code: created.code, name: 'Member' });
    expect((await updatedOnJoin)).toHaveLength(2);

    const updatedOnLeave = waitForEvent(owner, 'participants-updated');
    guest.disconnect();
    expect((await updatedOnLeave)).toHaveLength(1);
  });

  it('передаёт роль владельца следующему участнику после отключения владельца', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();
    await joinRoom(guest, { code: created.code, name: 'NextOwner' });

    const ownerChanged = waitForEvent(guest, 'owner-changed');
    owner.disconnect();
    const change = await ownerChanged;

    expect(change.owner).toMatchObject({ name: 'NextOwner', role: 'owner' });
  });
});

describe('Echo: администрирование, очистка и сессии', () => {
  it('позволяет владельцу удалить участника и отзывает его доступ', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();
    const joined = await joinRoom(guest, { code: created.code, name: 'KickTarget' });
    const participant = joined.participants.find((item) => item.name === 'KickTarget');

    const kicked = waitForEvent(guest, 'participant-kicked');
    owner.emit('kick-participant', { participantId: participant.id });
    await kicked;

    expect(getRoom(created.code).participants.size).toBe(1);
  });

  it('не позволяет обычному участнику выполнять административные действия', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();
    await joinRoom(guest, { code: created.code, name: 'Member' });

    const denied = emitAndWait(guest, 'close-room', undefined, 'chat-error');
    const error = await denied;

    expect(error.action).toBe('close-room');
    expect(getRoom(created.code)).toBeTruthy();
  });

  it('закрывает комнату владельцем и удаляет её из памяти', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();
    await joinRoom(guest, { code: created.code, name: 'ClosingGuest' });

    const closed = waitForEvent(guest, 'room-closed');
    owner.emit('close-room');
    await closed;

    expect(getRoom(created.code)).toBeUndefined();
  });

  it('удаляет пустую комнату единым уборщиком', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    owner.disconnect();
    await pause();
    const room = getRoom(created.code);
    room.lastActivityAt = Date.now() - (11 * 60 * 1000);

    echo.roomCleanup.removeExpiredRooms();

    expect(getRoom(created.code)).toBeUndefined();
  });

  it('закрывает неактивную комнату и уведомляет подключённого участника', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const room = getRoom(created.code);
    room.lastActivityAt = Date.now() - ((360 * 60 * 1000) + 1);

    const closed = waitForEvent(owner, 'room-closed');
    echo.roomCleanup.removeExpiredRooms();
    await closed;

    expect(getRoom(created.code)).toBeUndefined();
  });

  it('восстанавливает сессию без повторного PIN после временного отключения', async () => {
    const owner = await openSocket();
    const created = await createRoom(owner);
    const guest = await openSocket();
    const joined = await joinRoom(guest, { code: created.code, name: 'ReconnectGuest' });
    guest.disconnect();
    await pause();

    const resumedSocket = await openSocket();
    const resumed = emitAndWait(resumedSocket, 'resume-session', { code: created.code, token: joined.sessionToken }, 'session-resumed');
    const snapshot = await resumed;

    expect(snapshot.room.code).toBe(created.code);
    expect(snapshot.participants.some((participant) => participant.name === 'ReconnectGuest')).toBe(true);
  });
});
