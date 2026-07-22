# Echo — UI inventory

## Stack

Static HTML, a single shared CSS file and vanilla JavaScript. There is no component framework: component boundaries are stable HTML sections and their existing IDs/classes must remain intact because `public/index.js` and `public/chat.js` bind to them.

## Shared primitives

- **Brand**: `.brand` is the small `ec<span>ho</span>` wordmark and always returns home.
- **Eyebrow**: `.eyebrow` / `.card-label` label a section in compact uppercase text.
- **Card / panel**: `.card`, `.join-card`, `.invite-card`, `.participants-panel`, `.chat-panel`.
- **Fields**: `.field > label + input/select`, with `.field-grid` on the creation form.
- **Buttons**: primary `button`, `.button-secondary`, `.text-button`, `.icon-button`, `.kick-button`.
- **Feedback**: `.form-error`, `.notice-panel`, `.connection-state`, disabled controls.

## Landing page (`public/index.html`)

`header.landing-header`, `section.hero`, `.temporary-notice`, two working forms in `.action-grid`, then the dynamically shown `#invite-card` and `footer.site-footer`.

The creation form has stable IDs: `#create-room-form`, `#create-name`, `#create-pin`, `#create-confirm-pin`, `#create-transport-mode`, `#create-max-participants`, `#create-error`. The join form uses `#join-room-form`, `#join-code`, `#join-error`. Do not rename them.

## Room page (`public/room.html`)

Before joining it exposes `#join-panel` with `#room-join-form`. After joining, JavaScript hides it and shows `#room-layout`, made of:

1. `.participants-panel`: room code/copy action, connection mode, current identity, live participant list.
2. `.chat-panel`: `.chat-topbar`, owner controls, `#messages`, `#typing-indicator`, and the `#message-form` composer.

The page receives `.room-active` on `body` only after joining. This is a functional layout state: it locks the document viewport and makes the message feed the scrolling region. Preserve it.

## Dynamic elements owned by JavaScript

Messages, participant rows and all status text are built with `document.createElement` and `textContent`; CSS may change their presentation but must not replace them with HTML injection. The client toggles `hidden`, `disabled`, `is-connected`, `is-disconnected`, `is-info`, `own`, `participant-self` and `room-active`.
