# minimi-chat

A local chat with a memory of earlier turns and a way to read the live web. One Node process serves a single HTML page and stores the transcript in SQLite. The page never talks to a model.

`DESIGN.md` is the architecture: the turn, the date lookup, and `web_search`.

## Run

Node `>= 22.16`.

```sh
npm install
cp .env.example .env
npm run dev
```

Set `OPENROUTER_API_KEY`, `EXA_API_KEY`, and `FIRECRAWL_API_KEY` in `.env`. The process creates `data/chat.sqlite`, serves the page, and prints the local URL. The port defaults to `3000`. If that port is taken, it tries the next ten.

| Variable | Default |
| --- | --- |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4.6` |
| `OPENROUTER_PRIOR_MODEL` | `google/gemini-2.5-flash` |
| `TIMEZONE` | `Asia/Kolkata` |

Every calendar boundary is interpreted in `TIMEZONE`.

## Scripts

- `npm run dev` starts the server. `scripts/dev.mjs` loads `.env` and adds the experimental flags this Node version still needs for `node:sqlite` and TypeScript.
- `npm test` runs the date and prior-decision tests against a fixed clock.
- `npm run typecheck` runs `tsc --noEmit`.
