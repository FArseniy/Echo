const crypto = require('crypto');

function readPositiveInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function getWebRtcConfiguration() {
  const host = String(process.env.TURN_HOST || '').trim();
  const sharedSecret = String(process.env.TURN_SHARED_SECRET || '').trim();
  const stunPort = readPositiveInteger('TURN_STUN_PORT', 3478, { min: 1, max: 65535 });
  const tlsPort = readPositiveInteger('TURN_TLS_PORT', 5349, { min: 1, max: 65535 });

  if (!host || !sharedSecret) return { enabled: false, iceServers: [] };

  const expiresAt = Math.floor(Date.now() / 1000) + readPositiveInteger('TURN_CREDENTIAL_TTL_MINUTES', 30, { min: 5, max: 120 }) * 60;
  const username = `${expiresAt}:${crypto.randomUUID()}`;
  const credential = crypto.createHmac('sha1', sharedSecret).update(username).digest('base64');

  return {
    enabled: true,
    iceServers: [
      { urls: [`stun:${host}:${stunPort}`] },
      {
        urls: [
          `turn:${host}:${stunPort}?transport=udp`,
          `turn:${host}:${stunPort}?transport=tcp`,
          `turns:${host}:${tlsPort}?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  };
}

module.exports = { getWebRtcConfiguration };
