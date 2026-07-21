const crypto = require('crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});

function getMessagePayload(message) {
  return [
    message.id,
    message.senderId,
    message.senderName,
    String(message.createdAt),
    message.text,
  ].join('\n');
}

function signMessage(message) {
  return crypto.sign('sha256', Buffer.from(getMessagePayload(message), 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
}

function getMessageSigningPublicKey() {
  return publicKey.export({ format: 'jwk' });
}

module.exports = { getMessageSigningPublicKey, signMessage };
