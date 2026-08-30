# Routing notes

Explanations live here, not in `vercel.json`. Vercel validates that file against a
strict schema and **rejects unknown properties** — a `_comment` key fails the whole
deployment with "should NOT have additional property", and the build shows as an
error with 0ms duration, which looks like a platform fault rather than a config one.

## Why nothing sits at the web root

Vercel checks the filesystem *before* it consults `rewrites`, so a rule for `/` can
never fire while an `index.html` exists. The dispatch therefore lives in
`dispatch.html` (served at `/dispatch` by `cleanUrls`) and nothing occupies the root.
That empties `/` so the rewrites can decide what each domain shows:

- `event.getaheadsup.com/` → the talk page
- any other host (e.g. `econ-dispatch.vercel.app`) → the dispatch

Order matters: the host-specific rule must come first.

## Tabs as addresses

`/audit`, `/china`, `/compliance` and `/tools` all rewrite to `talk.html`. The browser
keeps the URL, and `openFromPath()` in that file reads `location.pathname` to choose
which tab opens. `/compliance` scrolls to the inlined guide; `/audit` scrolls to the
sorting tool. An explicit `#anchor` overrides both.

This keeps one copy of every piece of content while still giving each part a URL that
can be shared on its own.
