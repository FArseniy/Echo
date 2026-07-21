function createSlidingWindowLimiter({ limit, windowMs }) {
  const buckets = new Map();

  function consume(key) {
    const now = Date.now();
    const timestamps = (buckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);

    if (timestamps.length >= limit) {
      buckets.set(key, timestamps);
      return { allowed: false, retryAfter: timestamps[0] + windowMs };
    }

    timestamps.push(now);
    buckets.set(key, timestamps);
    return { allowed: true };
  }

  function remove(key) {
    buckets.delete(key);
  }

  function reset() {
    buckets.clear();
  }

  function cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of buckets) {
      const fresh = timestamps.filter((timestamp) => now - timestamp < windowMs);
      if (fresh.length === 0) buckets.delete(key);
      else buckets.set(key, fresh);
    }
  }

  return { consume, remove, cleanup, reset };
}

const messageLimiter = createSlidingWindowLimiter({ limit: 5, windowMs: 3 * 1000 });
const roomCreationLimiter = createSlidingWindowLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
const connectionLimiter = createSlidingWindowLimiter({ limit: 30, windowMs: 60 * 1000 });
const joinLimiter = createSlidingWindowLimiter({ limit: 30, windowMs: 60 * 1000 });
const resumeLimiter = createSlidingWindowLimiter({ limit: 20, windowMs: 60 * 1000 });
const typingLimiter = createSlidingWindowLimiter({ limit: 16, windowMs: 3 * 1000 });
const webRtcSignalLimiter = createSlidingWindowLimiter({ limit: 80, windowMs: 3 * 1000 });

setInterval(() => {
  messageLimiter.cleanup();
  roomCreationLimiter.cleanup();
  connectionLimiter.cleanup();
  joinLimiter.cleanup();
  resumeLimiter.cleanup();
  typingLimiter.cleanup();
  webRtcSignalLimiter.cleanup();
}, 60 * 1000).unref();

module.exports = {
  connectionLimiter,
  joinLimiter,
  messageLimiter,
  resumeLimiter,
  roomCreationLimiter,
  typingLimiter,
  webRtcSignalLimiter,
  resetLimiters() {
    messageLimiter.reset();
    roomCreationLimiter.reset();
    connectionLimiter.reset();
    joinLimiter.reset();
    resumeLimiter.reset();
    typingLimiter.reset();
    webRtcSignalLimiter.reset();
  },
};
