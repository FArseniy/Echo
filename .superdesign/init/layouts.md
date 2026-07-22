# Echo — layout inventory

## Landing

Centered content container (`.landing-page`) with a readable hero above a two-column action grid. At narrow widths the forms become one column; footer links stack.

## Room

Desktop uses a two-column app shell: a compact participant sidebar and a flexible chat column. The joined state uses viewport height, a `min-height: 0` flex chain and `#messages { overflow-y: auto }`. The composer remains at the bottom of `.chat-panel` immediately, even with no messages.

Tablet/mobile collapse sidebar above chat. The participant panel receives its own bounded scroll area so the composer remains reachable. At short viewport heights browser dynamic viewport units (`dvh`) are used.

## Layout constraints

- No page-level scrolling when `body.room-active` is set.
- Do not use transforms/animations that visually move the message composer.
- Keep content width comfortable on very wide screens and gutters usable at 320px.
