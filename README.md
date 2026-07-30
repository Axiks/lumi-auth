# lumi-auth

Standalone internal service that centralizes Kratos-admin/Telegram-Bot-API/WebAuthn-bridging
logic previously duplicated between `include-cookie-frontend` and `apps/catalog` (in the
`lumispace` monorepo). Mirrors `apps/bot`'s shape: plain Node `http` server, `x-internal-key`
auth, no framework, no database of its own — a stateless proxy in front of Ory Kratos, Ory
Hydra, the Telegram Bot API, and S3-compatible object storage (RustFS in dev).

Each consuming app (`include-cookie-frontend` and `apps/catalog`) keeps its own `/signin` UI and its own
NextAuth session issuance — this service only replaces the *admin-side* Kratos/Telegram
calls that used to live directly in each app. App-specific business logic (e.g. catalog's
admin-role bootstrap, Telegram bio/channel backfill, nickname whitespace healing) stays in
the calling app, applied as follow-up `PATCH /identities/:id` calls after login.

## Endpoints

All except `/health` require header `X-Internal-Key: <AUTH_INTERNAL_KEY>`.

| Method & path | Body / query | Does |
|---|---|---|
| `GET /health` | — | liveness check |
| `POST /telegram/widget-login` | `{params}` | verify Telegram Login Widget HMAC, find-or-create the Kratos identity |
| `POST /telegram/miniapp-login` | `{initData}` | verify Mini App initData, find-or-create the Kratos identity |
| `GET /telegram/chat-member` | `?chatId=&userId=` | raw Telegram `getChatMember` status (caller decides authorization) |
| `GET /identities/:id` | — | full profile traits (incl. `role`, `createdAt`) |
| `PATCH /identities/:id` | `{nickname?,about?,avatarUrl?,coverUrl?,links?,role?}` | trait merge-update |
| `DELETE /identities/:id` | — | permanently delete the identity (idempotent — 404 counts as success) |
| `GET /identities/:id/passkeys` | — | list registered WebAuthn credentials |
| `GET /identities/by-nickname/:nickname` | — | `{kratosId, tgId}` |
| `GET /identities` | `?q=` | list all, or nickname substring search |
| `POST /identities/batch` | `{ids}` | batch profile lookup |
| `GET /passkey/registration-flow` | `?kratosId=` | init the Kratos settings flow (WebAuthn registration) |
| `POST /passkey/registration-flow` | `{flowId,token,body}` | submit the flow |
| `POST /passkey/registration-remove` | `{kratosId,credentialId}` | remove a credential |
| `GET /hydra/login/:challenge` | — | fetch a Hydra OAuth2 login request |
| `POST /hydra/login/:challenge/accept` | `{subject,remember?,remember_for?}` | accept it, returns `{redirect_to}` |
| `GET /hydra/consent/:challenge` | — | fetch a Hydra OAuth2 consent request |
| `POST /hydra/consent/:challenge/accept` | `{grant_scope?,grant_access_token_audience?,remember?,remember_for?,session?}` | accept it, returns `{redirect_to}` |
| `POST /hydra/consent/:challenge/reject` | `{error?,error_description?}` | reject it, returns `{redirect_to}` |
| `POST /hydra/logout/:challenge/accept` | — | accept a Hydra OAuth2 logout request, returns `{redirect_to}` |

## Env

See `.env.example`. Needs `KRATOS_ADMIN_URL`/`KRATOS_PUBLIC_URL` (shared Kratos instance),
`HYDRA_ADMIN_URL` (shared Hydra instance), `BOT_TOKEN`, S3 credentials, and
`AUTH_INTERNAL_KEY` (shared secret with calling apps).

## Local dev

```bash
npm install
cp .env.example .env.local   # fill in real values, then export them or use dotenv-cli
npm run dev
```

## Docker

```bash
docker build -t lumi-auth .
```

## CI/CD

`.github/workflows/build-deploy.yml` (push to `master`) and `build-deploy-dev.yml` (push to
`development`) build and push `ghcr.io/axiks/lumi-auth:latest`/`:dev` + the commit SHA tag.
Both need a `GHCR_TOKEN` repo secret (a PAT with `write:packages`) — same as
`include-cookie-frontend`'s. The `lumispace` monorepo's `docker-compose.prod.yml`/
`docker-compose.dev-env.yml` pull these images directly; there's no build step on that side.
