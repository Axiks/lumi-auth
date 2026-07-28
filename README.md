# pandc-auth

Standalone internal service that centralizes Kratos-admin/Telegram-Bot-API/WebAuthn-bridging
logic previously duplicated between `pandc-web` and `apps/catalog` (in the `pandc-frontend`
monorepo). Mirrors `apps/bot`'s shape: plain Node `http` server, `x-internal-key` auth,
no framework, no database of its own — a stateless proxy in front of Ory Kratos, the
Telegram Bot API, and S3-compatible object storage (RustFS in dev).

Each consuming app (currently just `pandc-web`) keeps its own `/signin` UI and its own
NextAuth session issuance — this service only replaces the *admin-side* Kratos/Telegram
calls that used to live directly in each app.

## Endpoints

All except `/health` require header `X-Internal-Key: <AUTH_INTERNAL_KEY>`.

| Method & path | Body / query | Does |
|---|---|---|
| `GET /health` | — | liveness check |
| `POST /telegram/widget-login` | `{params}` | verify Telegram Login Widget HMAC, find-or-create the Kratos identity |
| `POST /telegram/miniapp-login` | `{initData}` | verify Mini App initData, find-or-create the Kratos identity |
| `GET /telegram/chat-member` | `?chatId=&userId=` | raw Telegram `getChatMember` status (caller decides authorization) |
| `GET /identities/:id` | — | full profile traits |
| `PATCH /identities/:id` | `{nickname?,about?,avatarUrl?,coverUrl?,links?}` | trait merge-update |
| `GET /identities/by-nickname/:nickname` | — | `{kratosId, tgId}` |
| `GET /identities` | `?q=` | list all, or nickname substring search |
| `POST /identities/batch` | `{ids}` | batch profile lookup |
| `GET /passkey/registration-flow` | `?kratosId=` | init the Kratos settings flow (WebAuthn registration) |
| `POST /passkey/registration-flow` | `{flowId,token,body}` | submit the flow |
| `POST /passkey/registration-remove` | `{kratosId,credentialId}` | remove a credential |

## Env

See `.env.example`. Needs `KRATOS_ADMIN_URL`/`KRATOS_PUBLIC_URL` (shared Kratos instance),
`BOT_TOKEN`, S3 credentials, and `AUTH_INTERNAL_KEY` (shared secret with calling apps).

## Local dev

```bash
npm install
cp .env.example .env.local   # fill in real values, then export them or use dotenv-cli
npm run dev
```

## Docker

```bash
docker build -t pandc-auth .
```
