import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { config } from "./config.js"
import * as kratos from "./kratos.js"
import * as passkey from "./passkey.js"
import { verifyWidget, verifyMiniapp, getChatMember, TelegramVerifyError } from "./telegram.js"
import { findOrCreateFromTelegram } from "./identities.js"

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

  // PATCH /identities/{id} { nickname?, about?, avatarUrl?, coverUrl?, links? }
  if (req.method === "PATCH" && (m = /^\/identities\/([^/]+)$/.exec(path))) {
    const kratosId = decodeURIComponent(m[1])
    const body = await readJsonBody(req)
    const ok = await kratos.updateTraits(kratosId, body)
    if (!ok) return json(res, 502, { error: "kratos_update_failed" })
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
