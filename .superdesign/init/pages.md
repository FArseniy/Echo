# Echo — pages and states

## Landing states

- Ready to create a room.
- Mode selection changes participant-limit availability and explanatory copy.
- Create error (including disconnected server).
- Created invitation with copy button and open-room link.
- Enter-by-code validation error.

## Room states

- Join form with room code, name and PIN.
- Restoring a session / reconnecting.
- Connected group room with message history and delivery status.
- Connected private P2P room with route/security state and no persisted history.
- Empty history, active typing indicator, error notice, room closed/kicked.
- Owner-only controls and normal member controls.

Every state must remain keyboard-accessible and must not require a mouse-only hover action.
