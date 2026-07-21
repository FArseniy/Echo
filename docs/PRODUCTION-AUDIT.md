# Echo — final production audit

Audit date: 2026-07-21. Scope: only the source code and deployment templates in this repository.

```text
create / join ─┐
resume session ├──► Socket.IO handler ───► in-memory room ───► room-only broadcast
admin action ──┘            │
                             └──► validation + rate limits + safe log metadata
```

## Critical problems

None found in the audited code.

## Important improvements

### Preserve the participant identifier after a disconnected-session resume

`resumeParticipant` creates a new participant object when the disconnected participant has already been removed. The new object receives a fresh UUID, while the stored session keeps the previous `participantId`. Room membership still works, but the token no longer describes the same internal participant identifier after this path.

Suggested targeted change:

```js
// src/rooms.js
function makeParticipant({ id = crypto.randomUUID(), socketId, name, role = 'member', joinedAt = Date.now() }) {
  return { id, socketId, name, role, joinedAt };
}

function addParticipant(room, { socketId, name, participantId }) {
  const participant = makeParticipant({
    id: participantId,
    socketId,
    name,
    role: room.participants.size === 0 ? 'owner' : 'member',
  });
  // Existing bookkeeping remains unchanged.
}

// src/socketHandlers.js, resumeParticipant()
return addParticipant(room, {
  socketId: socket.id,
  name: session.name,
  participantId: session.participantId,
});
```

Update the normal join call to pass `socketId` instead of the currently overloaded `id` field, and add a regression test that asserts the ID before and after reconnection is equal.

### Commit a dependency lock file

`package.json` uses version ranges but the repository has no `package-lock.json`. A lock file makes deployments reproducible and enables `npm ci --omit=dev`.

```bash
npm install --package-lock-only
git add package-lock.json
```

## Small improvements

- Expose the server's effective participant limit to the landing page so the HTML `max="50"` does not invite an invalid value when `MAX_ROOM_PARTICIPANTS=20`.
- Add integration tests for lock/unlock, history clearing, typing notifications, the 100-message cap, forbidden Origin and oversized Socket.IO payloads.
- Add a browser accessibility check (for example, axe) to CI. HTML labels, keyboard buttons, live regions and responsive media queries are already present, but this would verify contrast and screen-reader behaviour automatically.

## Verified design properties

- Room codes use `crypto.randomInt` with an 8-character non-ambiguous alphabet; PINs are bcrypt-hashed.
- The server, not the client, owns sender names, sender IDs, roles, room membership, timestamps and message IDs.
- A socket can send messages only through `socket.data.roomCode`; it cannot choose a target room in the event payload.
- History is capped at 100 messages and a join snapshot contains at most 50.
- Tokens are random, SHA-256-hashed server-side, expire after ten minutes, are revoked on leave/kick/room deletion, and are not stored in `localStorage`.
- Message and participant output is rendered with DOM nodes and `textContent`, not `innerHTML`.
- Helmet CSP, an exact `CLIENT_ORIGIN` check, `maxHttpBufferSize`, loopback binding, Nginx WebSocket headers and a systemd service template are included.
- Logs include only event metadata, socket ID, IP and technical error names; they do not serialize PINs, session tokens, message content or full socket payloads.

## Release gate

- [ ] Apply and test the stable-participant-ID adjustment above.
- [ ] Generate and commit `package-lock.json`.
- [ ] Run `npm test` and the post-publication `/healthz`, CORS and WebSocket checks from the README.
- [ ] Confirm `CLIENT_ORIGIN` and `PUBLIC_URL` are exact HTTPS origins.
- [ ] Keep `.env` outside Git and Node bound only to loopback behind Nginx.
