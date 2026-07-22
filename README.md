# echo

> A temporary room. A private link. A conversation that leaves when you do.

[Open Echo](https://echo.erised.click/) | [Russian README](README.ru.md) | [Design system](DESIGN_SYSTEM.md) | [Environment reference](.env.example)

```text
                         E C H O
              temporary conversations by link

          +-------------- room --------------+
          |                                  |
          |     create -- share -- talk      |
          |                                  |
          +----------------------------------+
                    |                  |
              private P2P         group room
             browser <-> browser   via Echo server
```

Echo is a no-registration chat for a quick conversation. Create a room, share its link and PIN separately, then close the room when the conversation is over. No accounts. No permanent profiles. No persistent chat history.

## Choose the route

| Mode | Best for | Message path | History |
| --- | --- | --- | --- |
| **Private P2P** | Two people on a direct connection | Browser to browser | Not stored |
| **Private P2P + TURN** | Two people who may need a fallback relay | Direct first; encrypted TURN relay if required | Not stored |
| **Group via server** | Rooms with several people | Socket.IO through Echo | Memory only, until the room closes |

### Private means private

In private P2P modes, Echo is used for the room entry flow, participant list and WebRTC signalling only. Message text is not relayed through Node.js, Socket.IO or Echo's temporary history.

WebRTC already encrypts transport. Echo additionally creates ephemeral ECDH P-256 keys in the browser and encrypts messages with AES-256-GCM. Participants can compare the displayed safety code outside the chat.

> Note: direct P2P is not anonymous. The other participant may be able to see your network address. TURN is a relay fallback, not an anonymity guarantee.

## What is included

- 8-character room codes and 4-8 digit PINs;
- bcrypt PIN hashing -- no PIN in URLs, `localStorage` or server logs;
- temporary names, presence list and owner handoff;
- real-time messaging, typing indicator and sent/delivered state;
- short session recovery with `sessionStorage`;
- PIN, message and room-creation rate limits;
- automatic cleanup of empty and inactive rooms;
- Helmet, strict Socket.IO origin checks, HTTPS and WebSocket-ready Nginx setup.

## Part of the erised tools

Need to share a screen as well? Try [Mirrised](https://mirror.erised.click/).  
Looking for the main project space? Visit [erised.click](https://www.erised.click/).

---

<details>
<summary><strong>Run Echo locally</strong></summary>

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`.

</details>

<details>
<summary><strong>Production notes</strong></summary>

- Put Nginx with HTTPS and WebSocket proxying in front of the app.
- Set `PUBLIC_URL`, `CLIENT_ORIGIN`, `TURN_HOST` and `TURN_SHARED_SECRET` in `.env`.
- Never commit `.env`, TURN credentials, room PINs or session tokens.
- Confirm `/healthz` returns `{"status":"ok"}` after deployment.

</details>

<details>
<summary><strong>Useful commands</strong></summary>

```bash
npm start
npm run dev
npm test
```

</details>

---

Built with Node.js, Express, Socket.IO, WebRTC and vanilla JavaScript.
