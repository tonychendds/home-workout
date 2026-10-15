# workout-sync

Cloudflare Worker that stores Workout accounts and per-record sync data in D1. It is separate from Upkeep's `upkeep-sync` database.

Public URL (after you deploy): https://workout-sync.tonychendds.workers.dev

This folder is published with the GitHub Pages site because Pages serves the repo root. It has no secrets. `database_id` in `wrangler.toml` is a placeholder until you create the database.

## Deploy

From this directory, on a machine signed in to the Cloudflare account that should own the worker:

```bash
npm install
npx wrangler login
npx wrangler d1 create workout-sync
```

Copy the printed `database_id` into `wrangler.toml`, replacing `00000000-0000-4000-8000-000000000000`. Then:

```bash
npx wrangler d1 migrations apply workout-sync --remote
npx wrangler deploy
```

Apply migrations before the first deploy, and again whenever `migrations/` changes. The only migration file is `0001_init.sql`. It creates `users`, `sessions`, and `records`. There is no password-reset migration and no Worker secret to set.

Expected URL after deploy: https://workout-sync.tonychendds.workers.dev

The site already calls that URL. Until the worker is deployed, signed-out use keeps working on the phone, and sign-in shows the error from the failed request.

## Local development

```bash
npm install
npx wrangler d1 migrations apply workout-sync --local
npx wrangler dev
```

`wrangler dev` uses a local D1 database. The web app can point at it with `?sync=http://127.0.0.1:8787`.

## What the API does

- `POST /auth/register` and `POST /auth/login` with `{ "email", "password" }`. `email` may be an email address or a username. Passwords are hashed with PBKDF2-SHA256 (100,000 iterations). Responses include a bearer token only after the row is stored. There is no password reset. Sync records are plain JSON; the password is not used to encrypt them.
- `POST /auth/logout` revokes the bearer token.
- `GET /auth/me` returns `{ email }` for the signed-in account.
- `POST /sync` with `{ "records": [...] }` upserts those records and returns the full set. An empty `records` array only reads. It does not delete anything.
- `GET /sync` reads every record for the signed-in account.

Each record is `{ id, type, updatedAt, deleted, payload }`. `type` is `exercise`, `pf`, or `progress`. A delete is stored as `deleted: true` and is never removed. A later push of a live copy does not bring it back.

A record whose JSON is over 90,000 characters, or whose photo is over 80,000 characters, is rejected with "A record is too large to store. Shrink the photo and try again." Nothing else in that request is written.

Last-write-wins applies to live edits (`updatedAt`, milliseconds).

## CORS

Allowed site origins live in `SITE_ORIGINS` at the top of `src/index.ts`. `https://tonychendds.github.io` stays in that list. To allow another origin, such as a future `*.pages.dev` host, add that exact origin string to `SITE_ORIGINS`. `http://localhost` and `http://127.0.0.1` (any port) are allowed for local development and are not part of that list.
