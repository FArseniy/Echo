# Echo — reusable components for Mirrised

The following visual building blocks can be recreated without Echo’s application logic:

- `AppShell`: centered, responsive frame with small wordmark and connection status.
- `SurfaceCard`: bordered translucent surface with medium/large radius.
- `Field`: labelled input/select plus optional quiet hint or error.
- `PrimaryButton`, `SecondaryButton`, `QuietButton`, `DangerButton`, `IconButton`.
- `StatusPill` and `ConnectionStatus`.
- `ServiceLink`: low-pressure cross-product card/link for Echo ↔ Mirrised.
- `FeedComposer`: fixed bottom action region within a scrollable application panel.
- `EmptyState` and inline `Notice`.

Mirrised should reuse tokens and interaction states, but it must not inherit Echo-specific ids, Socket.IO logic, PIN language or chat-only controls.
