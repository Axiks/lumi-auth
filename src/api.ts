import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { config } from "./config.js"
import * as kratos from "./kratos.js"
import * as passkey from "./passkey.js"
import * as hydra from "./hydra.js"
import { verifyWidget, verifyMiniapp, getChatMember, getAvatarBytesByTgId, TelegramVerifyError } from "./telegram.js"
import { findOrCreateFromTelegram } from "./identities.js"
import { saveFile, deleteFile } from "./s3-client.js"

const AVATAR_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
}
const MAX_AVATAR_BYTES = 8 * 1024 * 1024

function avatarMime(ext: string): string {
  return AVATAR_MIME[ext.toLowerCase()] ?? "application/octet-stream"
}

// Custom uploads are stored as a bare filename; an external URL (e.g. still pointing at
// Telegram in some legacy state) is never ours to delete.
function isCustomAvatar(avatarUrl: string | null): avatarUrl is string {
  return !!avatarUrl && !avatarUrl.startsWith("http")
}

// Internal REST surface for web/catalog (Docker network only — the port is never
// published). Auth: x-internal-key shared secret, mirroring apps/bot/src/api.ts and
// apps/catalog's own internal-key pattern.

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return typeof parsed === "object" && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = url.pathname

  if (req.method === "GET" && path === "/health") {
    return json(res, 200, { status: "ok", service: "auth" })
  }

  if (req.headers["x-internal-key"] !== config.internalKey) {
    return json(res, 401, { error: "unauthorized" })
  }

  let m: RegExpExecArray | null

  // POST /telegram/widget-login { params }
  if (req.method === "POST" && path === "/telegram/widget-login") {
    const body = await readJsonBody(req)
    const params = body.params as Record<string, string> | undefined
    if (!params) return json(res, 400, { error: "params_required" })
    try {
      const user = verifyWidget(params)
      const result = await findOrCreateFromTelegram(user)
      return json(res, 200, result)
    } catch (e) {
      if (e instanceof TelegramVerifyError) return json(res, 401, { error: e.code })
      console.error("[api] widget-login error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // POST /telegram/miniapp-login { initData }
  if (req.method === "POST" && path === "/telegram/miniapp-login") {
    const body = await readJsonBody(req)
    const initData = typeof body.initData === "string" ? body.initData : ""
    if (!initData) return json(res, 400, { error: "init_data_required" })
    try {
      const user = verifyMiniapp(initData)
      const result = await findOrCreateFromTelegram(user)
      return json(res, 200, result)
    } catch (e) {
      if (e instanceof TelegramVerifyError) return json(res, 401, { error: e.code })
      console.error("[api] miniapp-login error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // GET /telegram/chat-member?chatId=&userId=
  if (req.method === "GET" && path === "/telegram/chat-member") {
    const chatId = url.searchParams.get("chatId")
    const userId = url.searchParams.get("userId")
    if (!chatId || !userId) return json(res, 400, { error: "chatId_and_userId_required" })
    const status = await getChatMember(chatId, userId)
    return json(res, 200, { status })
  }

  // GET /identities/by-nickname/{nickname}
  if (req.method === "GET" && (m = /^\/identities\/by-nickname\/([^/]+)$/.exec(path))) {
    const found = await kratos.findByNickname(decodeURIComponent(m[1]))
    if (!found) return json(res, 404, { error: "not_found" })
    return json(res, 200, found)
  }

  // GET /identities?q=  (list all, or substring nickname search)
  if (req.method === "GET" && path === "/identities") {
    const q = url.searchParams.get("q") ?? undefined
    const results = await kratos.listOrSearch(q)
    return json(res, 200, results)
  }

  // POST /identities/batch { ids }
  if (req.method === "POST" && path === "/identities/batch") {
    const body = await readJsonBody(req)
    const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : []
    const result = await kratos.batchProfiles(ids)
    return json(res, 200, result)
  }

  // GET /identities/{id}/passkeys
  if (req.method === "GET" && (m = /^\/identities\/([^/]+)\/passkeys$/.exec(path))) {
    const passkeys = await kratos.listPasskeys(decodeURIComponent(m[1]))
    return json(res, 200, passkeys)
  }

  // GET /identities/{id}
  if (req.method === "GET" && (m = /^\/identities\/([^/]+)$/.exec(path))) {
    const identity = await kratos.getIdentity(decodeURIComponent(m[1]))
    if (!identity) return json(res, 404, { error: "not_found" })
    return json(res, 200, identity)
  }

  // PATCH /identities/{id} { nickname?, about?, avatarUrl?, coverUrl?, links?, role? }
  if (req.method === "PATCH" && (m = /^\/identities\/([^/]+)$/.exec(path))) {
    const kratosId = decodeURIComponent(m[1])
    const body = await readJsonBody(req)
    const ok = await kratos.updateTraits(kratosId, body)
    if (!ok) return json(res, 502, { error: "kratos_update_failed" })
    return json(res, 204, undefined)
  }

  // DELETE /identities/{id} — permanently deletes the account.
  if (req.method === "DELETE" && (m = /^\/identities\/([^/]+)$/.exec(path))) {
    const kratosId = decodeURIComponent(m[1])
    const ok = await kratos.deleteIdentity(kratosId)
    if (!ok) return json(res, 502, { error: "kratos_delete_failed" })
    return json(res, 204, undefined)
  }

  // GET /passkey/registration-flow?kratosId=
  if (req.method === "GET" && path === "/passkey/registration-flow") {
    const kratosId = url.searchParams.get("kratosId")
    if (!kratosId) return json(res, 400, { error: "kratosId_required" })
    try {
      const result = await passkey.registrationFlowInit(kratosId)
      return json(res, 200, result)
    } catch (e) {
      console.error("[api] registration-flow init error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // POST /passkey/registration-flow { kratosId, flowId, token, body }
  if (req.method === "POST" && path === "/passkey/registration-flow") {
    const body = await readJsonBody(req)
    const { flowId, token, body: flowBody } = body as { flowId?: string; token?: string; body?: Record<string, unknown> }
    if (!flowId || !token || !flowBody) return json(res, 400, { error: "flowId_token_body_required" })
    try {
      const result = await passkey.registrationFlowSubmit({ flowId, token, body: flowBody })
      return json(res, result.status, result.data)
    } catch (e) {
      console.error("[api] registration-flow submit error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // POST /passkey/registration-remove { kratosId, credentialId }
  if (req.method === "POST" && path === "/passkey/registration-remove") {
    const body = await readJsonBody(req)
    const { kratosId, credentialId } = body as { kratosId?: string; credentialId?: string }
    if (!kratosId || !credentialId) return json(res, 400, { error: "kratosId_and_credentialId_required" })
    try {
      const result = await passkey.removeCredential(kratosId, credentialId)
      return json(res, result.status, result.data)
    } catch (e) {
      console.error("[api] registration-remove error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // POST /identities/{id}/avatar { data: base64, ext }
  if (req.method === "POST" && (m = /^\/identities\/([^/]+)\/avatar$/.exec(path))) {
    const kratosId = decodeURIComponent(m[1])
    const body = await readJsonBody(req)
    const data = typeof body.data === "string" ? body.data : ""
    const ext = typeof body.ext === "string" ? body.ext.replace(/[^a-z0-9]/gi, "").toLowerCase() : ""
    if (!data || !ext) return json(res, 400, { error: "data_and_ext_required" })
    const buffer = Buffer.from(data, "base64")
    if (buffer.length === 0) return json(res, 400, { error: "empty_file" })
    if (buffer.length > MAX_AVATAR_BYTES) return json(res, 413, { error: "file_too_large" })
    try {
      const current = await kratos.getIdentity(kratosId)
      if (isCustomAvatar(current?.avatarUrl ?? null)) {
        await deleteFile("avatars", current!.avatarUrl!).catch(() => {})
      }
      const filename = `${randomUUID()}.${ext}`
      await saveFile(buffer, "avatars", filename, avatarMime(ext))
      const ok = await kratos.updateTraits(kratosId, { avatarUrl: filename })
      if (!ok) return json(res, 502, { error: "kratos_update_failed" })
      return json(res, 200, { filename })
    } catch (e) {
      console.error("[api] avatar upload error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // DELETE /identities/{id}/avatar
  if (req.method === "DELETE" && (m = /^\/identities\/([^/]+)\/avatar$/.exec(path))) {
    const kratosId = decodeURIComponent(m[1])
    try {
      const current = await kratos.getIdentity(kratosId)
      if (isCustomAvatar(current?.avatarUrl ?? null)) {
        await deleteFile("avatars", current!.avatarUrl!).catch(() => {})
      }
      const ok = await kratos.updateTraits(kratosId, { avatarUrl: "" })
      if (!ok) return json(res, 502, { error: "kratos_update_failed" })
      return json(res, 204, undefined)
    } catch (e) {
      console.error("[api] avatar delete error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // POST /identities/{id}/avatar/from-telegram — reads the identity's own tgId, never a
  // client-supplied one.
  if (req.method === "POST" && (m = /^\/identities\/([^/]+)\/avatar\/from-telegram$/.exec(path))) {
    const kratosId = decodeURIComponent(m[1])
    try {
      const current = await kratos.getIdentity(kratosId)
      if (!current) return json(res, 404, { error: "not_found" })
      if (!current.tgId) return json(res, 400, { error: "no_telegram_linked" })
      const img = await getAvatarBytesByTgId(current.tgId)
      if (!img) return json(res, 404, { error: "avatar_not_found" })
      if (isCustomAvatar(current.avatarUrl)) {
        await deleteFile("avatars", current.avatarUrl!).catch(() => {})
      }
      const filename = `${randomUUID()}.${img.ext}`
      await saveFile(img.bytes, "avatars", filename, avatarMime(img.ext))
      const ok = await kratos.updateTraits(kratosId, { avatarUrl: filename })
      if (!ok) return json(res, 502, { error: "kratos_update_failed" })
      return json(res, 200, { filename })
    } catch (e) {
      console.error("[api] avatar from-telegram error:", e)
      return json(res, 500, { error: "internal" })
    }
  }

  // GET /hydra/login/{challenge}
  if (req.method === "GET" && (m = /^\/hydra\/login\/([^/]+)$/.exec(path))) {
    try {
      const result = await hydra.getLoginRequest(decodeURIComponent(m[1]))
      return json(res, 200, result)
    } catch (e) {
      console.error("[api] hydra login-request error:", e)
      return json(res, 502, { error: "hydra_unreachable" })
    }
  }

  // POST /hydra/login/{challenge}/accept { subject, remember?, remember_for? }
  if (req.method === "POST" && (m = /^\/hydra\/login\/([^/]+)\/accept$/.exec(path))) {
    const body = await readJsonBody(req)
    const subject = typeof body.subject === "string" ? body.subject : ""
    if (!subject) return json(res, 400, { error: "subject_required" })
    try {
      const result = await hydra.acceptLoginRequest(decodeURIComponent(m[1]), {
        subject,
        remember: body.remember as boolean | undefined,
        remember_for: body.remember_for as number | undefined,
      })
      return json(res, 200, result)
    } catch (e) {
      console.error("[api] hydra login-accept error:", e)
      return json(res, 502, { error: "hydra_unreachable" })
    }
  }

  // GET /hydra/consent/{challenge}
  if (req.method === "GET" && (m = /^\/hydra\/consent\/([^/]+)$/.exec(path))) {
    try {
      const result = await hydra.getConsentRequest(decodeURIComponent(m[1]))
      return json(res, 200, result)
    } catch (e) {
      console.error("[api] hydra consent-request error:", e)
      return json(res, 502, { error: "hydra_unreachable" })
    }
  }

  // POST /hydra/consent/{challenge}/accept { grant_scope?, grant_access_token_audience?, remember?, remember_for?, session? }
  if (req.method === "POST" && (m = /^\/hydra\/consent\/([^/]+)\/accept$/.exec(path))) {
    const body = await readJsonBody(req)
    try {
      const result = await hydra.acceptConsentRequest(decodeURIComponent(m[1]), {
        grant_scope: body.grant_scope as string[] | undefined,
        grant_access_token_audience: body.grant_access_token_audience as string[] | undefined,
        remember: body.remember as boolean | undefined,
        remember_for: body.remember_for as number | undefined,
        session: body.session as { id_token?: Record<string, unknown> } | undefined,
      })
      return json(res, 200, result)
    } catch (e) {
      console.error("[api] hydra consent-accept error:", e)
      return json(res, 502, { error: "hydra_unreachable" })
    }
  }

  // POST /hydra/consent/{challenge}/reject { error?, error_description? }
  if (req.method === "POST" && (m = /^\/hydra\/consent\/([^/]+)\/reject$/.exec(path))) {
    const body = await readJsonBody(req)
    try {
      const result = await hydra.rejectConsentRequest(decodeURIComponent(m[1]), {
        error: body.error as string | undefined,
        error_description: body.error_description as string | undefined,
      })
      return json(res, 200, result)
    } catch (e) {
      console.error("[api] hydra consent-reject error:", e)
      return json(res, 502, { error: "hydra_unreachable" })
    }
  }

  // POST /hydra/logout/{challenge}/accept
  if (req.method === "POST" && (m = /^\/hydra\/logout\/([^/]+)\/accept$/.exec(path))) {
    try {
      const result = await hydra.acceptLogoutRequest(decodeURIComponent(m[1]))
      return json(res, 200, result)
    } catch (e) {
      console.error("[api] hydra logout-accept error:", e)
      return json(res, 502, { error: "hydra_unreachable" })
    }
  }

  return json(res, 404, { error: "not_found" })
}

export function startApi(): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      console.error("[api] error:", e)
      if (!res.headersSent) json(res, 500, { error: "internal" })
    })
  })
  server.listen(config.healthPort, () => {
    console.log(`[auth] listening on :${config.healthPort}`)
  })
  return server
}
