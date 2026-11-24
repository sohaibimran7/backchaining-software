# Backchain

A live workshop tool for working backwards from a goal. A small group joins on their phones. The group proposes a goal, the states of the world that would lead to it, how those connect, and what people could actually do. Everyone keeps their own model. One person can also use it alone.

Nothing here is a quiz over a prepared model: an empty workshop is the normal starting point, and the model is whatever the group builds.

## What it does

- **Participant view (phone).** One question at a time, pushed live by the organizer. Suggestions, choices, percentage-point sliders, "not sure" always available. Answers can be revised later; earlier versions are kept. Other people's answers stay hidden until the organizer reveals them.
- **Organizer view.** Create a workshop, show the join link and QR code, ask questions from an automatically generated queue, sort incoming suggestions (accept, merge with confirmation, set aside), record the goal, and control five layers separately: goals, states, actions, connections, estimates. Each layer has two switches: *own work* and *pooled*.
- **Map and explorer.** An interactive map of one model at a time. Draw arrows by dragging, or tap one item then another. Search, focus on a neighbourhood, fold branches away. Loops are refused with a plain explanation. One "?" marker per arrow opens the question the selected calculation method still needs.
- **Solo mode.** One person defines the goal, states, arrows, estimates and actions, and gets results, with no organizer or other participants.
- **Combine.** Preview two or more people's maps side by side, decide arrow by arrow where they differ, optionally pool estimates, and save the result as a separate, versioned combined map. Personal maps are never overwritten.
- **Results.** Replaceable calculation methods. The arithmetic is done by [Squiggle](https://www.squiggle-language.com/); what counts as valid, missing or unsupported is decided by the method.

## Run it locally

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite).

```bash
npm install
npm run build
npm start
```

Open http://localhost:8787. Data is stored in `./data/workshops.sqlite` and survives restarts.

For development with hot reload (web on port 5173, API on 8787):

```bash
npm run dev
```

### Phones need a reachable address

`localhost` only works on the computer running the server. On the same Wi-Fi, open the app on the organizer's computer using its network address (for example `http://192.168.1.20:8787`); the Join panel offers the detected addresses. For anything else, set `PUBLIC_BASE_URL` (see below) so the join link and QR code point at the right place.

## Configuration

Copy `.env.example` to `.env` in the folder you start the server from. Every value is optional. The server reads that file itself at startup (no extra package), and a variable already set in the environment takes precedence over the file.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 8787) |
| `DATA_DIR` | Where the SQLite file lives (default `./data`) |
| `PUBLIC_BASE_URL` | Address participants use; drives the join link and QR code |
| `ALLOWED_ORIGINS` | Extra origins allowed to call the API |
| `CREATE_WORKSHOP_SECRET` | If set, creating or importing a workshop needs this phrase |
| `CALCULATION_TIME_LIMIT_MS` | Longest a calculation may run before it is terminated |

Everything about a workshop's content is configured per workshop from **Configure** in the organizer view, and can be exported and imported as JSON: wording and colours, stages, question templates, the calculation method and its settings, the default way estimates are pooled, privacy defaults. No code change is needed to reword a question or add a stage.

## Deploying

The server is one Node process that serves the API, the websocket and the built web app, and writes one SQLite file. Any host that runs a long-lived Node process with a persistent disk works (a small VM, Fly.io with a volume, Render with a disk, Railway with a volume).

1. `npm ci && npm run build`
2. Run `npm start` with `PUBLIC_BASE_URL` set to your HTTPS address and `DATA_DIR` on the persistent disk.
3. Put it behind HTTPS (the host's proxy is fine; websockets must be allowed on `/ws`).
4. Set `CREATE_WORKSHOP_SECRET` so strangers cannot create workshops.

It is not designed for serverless platforms: live sync needs a process that stays up. To use Postgres or Supabase instead of SQLite, implement the small `Store` interface in `server/store.ts`; nothing else touches the database. No hosted service or paid account is needed to run the app.

## Tests

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm test` runs the unit and service tests, including the real Squiggle engine. `npm run test:e2e` drives the production build in a real browser with three separate sessions (one organizer, two phones). The first time, install the browser with `npx playwright install chromium`.

## How results are calculated

Three methods ship. All are in `shared/calc/` and none is built into the user interface. Whenever a method is selected, its assumptions and limitations are shown in full beside it.

- **Structure only (no ranking)** — the default. Describes each model: which actions connect to the goal, what is marked as required, where routes narrow, what is unknown. Produces no numbers.
- **Rank actions by added-up probability changes (local additive approximation)** — opt-in. For each arrow it asks one thing: how many percentage points the first item changes the chance of the next, compared with the same expected course of events without it. It ranks actions by their estimated change to the chance of the goal. It never states the chance of the goal itself. It withholds the number and the rank wherever its assumptions visibly fail: a loop, something marked as required, an arrow that holds only under some conditions, or added-up changes larger than a chance can change by. Missing and "not sure" answers make a result incomplete, never zero.

- **Rank actions from two chances per arrow (local additive approximation)** — opt-in. The same arithmetic and safeguards, but it asks two questions per arrow: how likely the next item is if this one happens, and if it does not. The change is the difference. It costs a second answer per arrow. In return, an answer near 0% or 100% carries information a bare change cannot, which allows pooling in log-odds, and a requirement contradicted by the answers is flagged.

Differences between pairs of items do not, in general, determine how things interact. The second method is an approximation for ranking under stated assumptions, which are shown in the method picker, beside every result, and stored with every run. See [docs/CALCULATION_METHODS.md](docs/CALCULATION_METHODS.md) for the contract and how to add a method.

## Limits worth knowing

- The ranking method is one defensible approximation, not a settled science. The method contract exists so it can be replaced.
- Loops are refused everywhere in this version, including an item connected to itself.
- Pooling estimates is off by default. Four ways are available: a simple average, the middle estimate (median), an average weighted by how narrow each person's range is, and an average of the odds (chances only, so it needs the two-chances method). None of them recovers evidence people did not express; a reveal-and-re-estimate round does that better. Answers given against different surroundings are not pooled by default; they are listed for re-asking.
- Access is by unguessable links held in the browser, not accounts. Losing the organizer link means losing organizer access to that workshop.
- A merge of two items cannot be undone in place. Use **History → Open a copy as of here** to recover an earlier state as a separate workshop.
- Results are drawn as ranges and tiers. Squiggle's chart components are not used, because this version produces no probability distributions to plot.
- Tested with 52 items in the browser and hundreds in unit tests; not load-tested beyond a workshop-sized group.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit, and the trade-offs taken.
- [docs/CALCULATION_METHODS.md](docs/CALCULATION_METHODS.md) — the calculation and aggregation contracts.

MIT licence.
