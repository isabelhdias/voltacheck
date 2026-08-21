# Design source

`VoltaCheck.dc.html` is the redesign handoff from Claude Design
(claude.ai/design), committed here so the implementation has a reference
that does not depend on a share link — the original is behind a login this
repo's agents cannot reach.

It is a **prototype**, not production code: a canvas of phone-sized
artboards, using a `<x-dc>` / `sc-if` runtime (`support.js` in the original
bundle) that is deliberately NOT vendored, since nothing in it ships. Read
it for values — colours, type, spacing, copy — not for structure.

Where the built app and this file disagree, the reasons are written down in
`docs/redesign.md`.
