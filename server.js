require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { connectionLimiter } = require('./src/limits');
const { startRoomCleanup } = require('./src/roomCleanup');
const { clearPinAttemptsForRoom, registerSocketHandlers } = require('./src/socketHandlers');

function getRequestAddress(request) {
  const realIp = request.headers['x-real-ip'];
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) return forwardedFor.split(',')[0].trim();
  return request.socket.remoteAddress || 'unknown';
}

function readPositiveInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function createEchoServer({ publicUrl, allowedOrigin } = {}) {
  const app = express();
  const server = http.createServer(app);
  const resolvedPublicUrl = (publicUrl || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  const resolvedAllowedOrigin = (allowedOrigin || process.env.CLIENT_ORIGIN || process.env.ALLOWED_ORIGIN || resolvedPublicUrl).replace(/\/$/, '');
  const websocketOrigin = resolvedAllowedOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  const turnHost = String(process.env.TURN_HOST || '').trim();
  const turnSources = turnHost
    ? [`stun:${turnHost}:3478`, `turn:${turnHost}:3478`, `turns:${turnHost}:5349`]
    : [];
  const isAllowedOrigin = (origin) => typeof origin === 'string' && origin === resolvedAllowedOrigin;
  const allowedHosts = new Set([
    new URL(resolvedPublicUrl).host,
    new URL(resolvedAllowedOrigin).host,
  ]);

  // Browsers may omit Origin for a same-origin Engine.IO request. In that case
  // accepting only the configured Host preserves same-origin access without
  // opening the endpoint to arbitrary cross-origin browser requests.
  const isAllowedHandshakeOrigin = (request) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin) return isAllowedOrigin(origin);
    return typeof request.headers.host === 'string' && allowedHosts.has(request.headers.host);
  };
  const maxSocketPacketBytes = readPositiveInteger('MAX_SOCKET_PACKET_BYTES', 10 * 1024, { min: 1024, max: 1024 * 1024 });

  const io = new Server(server, {
    maxHttpBufferSize: maxSocketPacketBytes,
    cors: {
      origin(origin, callback) {
        callback(null, isAllowedOrigin(origin));
      },
      methods: ['GET', 'POST'],
      credentials: false,
    },
    allowRequest(request, callback) {
      const isHandshake = !new URL(request.url, 'http://localhost').searchParams.has('sid');
      const originAllowed = isAllowedHandshakeOrigin(request);
      const allowedByRateLimit = !isHandshake || connectionLimiter.consume(getRequestAddress(request)).allowed;

      if (!originAllowed || !allowedByRateLimit) {
        // Origin and rejection category are safe operational metadata. Never log
        // packet payloads, PINs, session tokens, messages, or IP addresses here.
        console.warn('[echo]', JSON.stringify({
          event: 'socket-handshake-rejected',
          reason: originAllowed ? 'rate-limit' : 'origin',
          origin: typeof request.headers.origin === 'string' ? request.headers.origin : null,
        }));
      }

      callback(null, originAllowed && allowedByRateLimit);
    },
  });

  io.engine.on('connection_error', (error) => {
    console.warn('[echo]', JSON.stringify({ event: 'socket-packet-rejected', code: error.code }));
  });

  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        baseUri: ["'self'"],
        connectSrc: ["'self'", websocketOrigin, ...turnSources],
        defaultSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
  }));
  app.get('/healthz', (request, response) => response.status(200).json({ status: 'ok' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/room', (request, response) => response.sendFile(path.join(__dirname, 'public', 'room.html')));

  registerSocketHandlers(io, { publicUrl: resolvedPublicUrl });
  const roomCleanup = startRoomCleanup(io, { clearRoomTemporaryData: clearPinAttemptsForRoom });

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    roomCleanup.stop();
    return new Promise((resolve) => {
      io.close(() => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    });
  }

  return { app, close, io, listen, roomCleanup, server };
}

if (require.main === module) {
  const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
  const echo = createEchoServer();
  echo.listen(PORT).then(() => console.log(`Echo запущен: http://localhost:${PORT}`));

  let isShuttingDown = false;
  function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Echo останавливается (${signal}).`);
    echo.io.emit('room-closed', { message: 'Сервер остановлен. Временные комнаты и история очищены.' });
    echo.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createEchoServer };
