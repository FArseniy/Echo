# Echo — routes

| Route | Page | Notes |
| --- | --- | --- |
| `/` | Landing | Creates a room or enters an eight-character room code. |
| `/room` | Room | Server route for the room UI. |
| `/room.html?room=CODE` | Room | Invitation URL and code prefill path. |
| `/healthz` | JSON | Production health check, not a UI route. |

There is no public room directory, account page or settings route.
