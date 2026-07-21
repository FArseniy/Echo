const { io } = require('socket.io-client');

const TEST_ORIGIN = 'http://test.echo.local';

function waitForEvent(socket, event, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

function expectNoEvent(socket, event, timeout = 250) {
  return new Promise((resolve, reject) => {
    function onEvent(payload) {
      clearTimeout(timer);
      reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
    }
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, timeout);
    socket.once(event, onEvent);
  });
}

async function connectSocket(url) {
  const socket = io(url, {
    transports: ['websocket'],
    extraHeaders: { Origin: TEST_ORIGIN },
    forceNew: true,
    reconnection: false,
  });
  await waitForEvent(socket, 'connect');
  return socket;
}

function emitAndWait(socket, emittedEvent, payload, responseEvent) {
  const response = waitForEvent(socket, responseEvent);
  socket.emit(emittedEvent, payload);
  return response;
}

function pause(milliseconds = 25) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  TEST_ORIGIN,
  connectSocket,
  emitAndWait,
  expectNoEvent,
  pause,
  waitForEvent,
};
