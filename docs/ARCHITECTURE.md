# Architecture

## Layout

```
shared/     Domain logic, used by both server and browser. No I/O.
  types.ts, config.ts, defaultConfig.ts   data shapes; the configurable workshop definition
  commands.ts                             every change a client may request (validated with zod)
  engine.ts                               applies one command to the state; permissions; loop checks
  templates.ts                            question templates → concrete questions; staleness
  model.ts                                extracts ONE person's model as plain data
  synthesis.ts                            preview and build combined maps
  cycles.ts                               loop detection
  views.ts                                what each role is allowed to see
  calc/                                   calculation methods, registry, contract
  aggregate/                              ways of pooling estimates, registry, contract
server/
  store.ts                                storage adapter (SQLite and in-memory)
  service.ts                              identity, commands, persistence, live fan-out, export/import
  app.ts                                  HTTP API (Hono)
  squiggleEngine.ts, squiggleWorker.mjs   the formula engine, in a worker thread
  index.ts                                process entry: HTTP, websocket, static files
web/src/    React app: pages/ (Home, Join, Participant, Facilitator, Explorer) and components/
tests/      unit/ (Vitest) and e2e/ (Playwright)
```

## Data flow

Every change is a **command**. The server validates it, applies it to a copy of the workshop state with `execute()`, and only if that succeeds appends it to the event log and keeps the new state. Replaying the log rebuilds a workshop exactly, which gives persistence across restarts, the revision history, export/import, and "open a copy as of revision N" from one mechanism.

After each change the server computes a **view** per connected role and pushes it over a websocket. Filtering happens on the server (`shared/views.ts`), so hidden answers, personal items, personal arrows and other people's formulas never reach another device.

## Separate models

There is one shared vocabulary of items and candidate arrows. Everything a person believes is an answer tied to that person, a question, the definitions it was given against, and a revision number. A person's model is derived from their own answers only (`buildParticipantModel`). An arrow someone else proposed shows as "not reviewed" in your model, which is distinct from rejected, unsure and absent.

When a definition, the goal or the time horizon changes, answers are kept and flagged for review rather than discarded.

## Layers and pooling

The organizer controls five layers independently: goals, states, actions, connections, estimates. *Own work* lets people work on a layer themselves; *pooled* shows everyone the combined catalogue for it. Pooling is a visibility setting, so it can be changed at any time and never overwrites anything. Three things are kept distinct: a shared catalogue of candidates, visibility of someone's whole model (`shareModels`), and a synthesized combined model.

## Combined models

A synthesis is its own stored object: contributors, explicit include/exclude decisions for arrows not everyone holds, and an aggregation method. It is always previewed first. Saving is refused if the chosen arrows form a loop. Each save is a new version; earlier versions can be restored; the whole thing can be put away.

## Loops

`shared/cycles.ts` is called wherever an arrow can enter someone's map: drawing, answering "yes" to a proposed arrow, the organizer entering an answer on someone's behalf, merging two items, replaying an import, and saving a combined map. Checks run on the server against the whole map.

## Identity and permissions

Creating a workshop returns an organizer key; joining returns a participant key. Keys are random, stored hashed, sent in an `Authorization` header (never a cookie), and live in the browser's local storage. Personal links carry the key after `#` so it is not sent in requests. The organizer can issue a participant a fresh link, which invalidates the old one.

## Calculations

Calculation methods are pure, synchronous translators: check the model against the method's assumptions, then emit formulas. The formula engine (Squiggle, in a worker thread with a time and memory limit) only evaluates them. Runs for a workshop are queued in request order, and a result computed from a model that changed meanwhile is discarded and recomputed. Each run stores the method version, settings, assumptions, engine version, sampling settings (none: exact arithmetic), model revision, generated formulas and the mapping from generated names back to arrows and questions.

## Trade-offs

- **SQLite with a websocket instead of Supabase.** The brief suggested Supabase but required the app to run without hosted credentials and with real cross-device sync. One Node process with SQLite does that with no account. The `Store` interface is the seam for Postgres or Supabase.
- **Full view on every change, not diffs.** Simpler and hard to get wrong for privacy. Fine at workshop scale; the first thing to change for very large maps.
- **Node's built-in SQLite.** No native build step. It requires Node 22.13+ and is still marked experimental by Node.
- **Link-based access, no accounts.** Low friction for a room of five. Not suitable where individual sign-in is required.
- **Vitest 3.** It has open advisories in its development-only mocking and worker code. Nothing from it ships in the app.
