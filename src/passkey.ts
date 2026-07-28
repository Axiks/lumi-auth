import { config } from "./config.js"

const KRATOS_PUBLIC_URL = process.env.KRATOS_PUBLIC_URL || "http://localhost:4433"
const ADMIN = config.kratosAdminUrl

// Mints a temporary `ory_kratos_session` cookie for `kratosId` via the admin recovery-code
// flow, so we can drive the settings flow (WebAuthn registration/removal) on the user's
// behalf without them re-authenticating. Ported as-is from pandc-web's pre-extraction
// app/api/kratos/settings/route.ts.
async function getSessionCookie(kratosId: string): Promise<string> {
  const codeRes = await fetch(`${ADMIN}/admin/recovery/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity_id: kratosId, expires_in: "10m" }),
  })
  if (!codeRes.ok) throw new Error(`Recovery code creation failed: ${await codeRes.text()}`)
  const { recovery_code: code, recovery_link } = await codeRes.json() as { recovery_code: string; recovery_link: string }

  const flowId = new URL(recovery_link).searchParams.get("flow")
  if (!flowId) throw new Error("No flow ID in recovery_link")

  const submitRes = await fetch(`${KRATOS_PUBLIC_URL}/self-service/recovery?flow=${flowId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ method: "code", code }),
  })

  const cookie = submitRes.headers.get("set-cookie") ?? ""
  const match = cookie.match(/ory_kratos_session=([^;]+)/)
  if (!match) throw new Error("Kratos did not return session cookie after recovery")
  return match[1]
}

function extractSetCookies(headers: Headers): string[] {
  return (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : [])
}

export async function registrationFlowInit(kratosId: string): Promise<{ flow: unknown; token: string }> {
  const sessionCookie = await getSessionCookie(kratosId)

  const flowRes = await fetch(`${KRATOS_PUBLIC_URL}/self-service/settings/browser`, {
    headers: { Accept: "application/json", Cookie: `ory_kratos_session=${sessionCookie}` },
  })
  const flow = await flowRes.json() as { ui?: { nodes?: { attributes?: { name?: string; value?: string } }[] } }

  const csrfCookieKV = extractSetCookies(flowRes.headers)
    .map(c => c.split(";")[0])
    .find(c => c.startsWith("csrf_token")) ?? ""
  const csrfToken = flow.ui?.nodes?.find(n => n.attributes?.name === "csrf_token")?.attributes?.value ?? ""

  const token = JSON.stringify({ cookie: sessionCookie, csrf: csrfToken, csrfCookie: csrfCookieKV })
  return { flow, token }
}

export async function registrationFlowSubmit(params: {
  flowId: string
  token: string
  body: Record<string, unknown>
}): Promise<{ status: number; data: unknown }> {
  const { cookie, csrf, csrfCookie } = JSON.parse(params.token) as { cookie: string; csrf: string; csrfCookie: string }
  const cookieHeader = [`ory_kratos_session=${cookie}`, csrfCookie].filter(Boolean).join("; ")

  const res = await fetch(`${KRATOS_PUBLIC_URL}/self-service/settings?flow=${params.flowId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: cookieHeader },
    body: JSON.stringify({ ...params.body, csrf_token: csrf }),
  })
  const data = await res.json()
  return { status: res.status, data }
}

export async function removeCredential(kratosId: string, credentialId: string): Promise<{ status: number; data: unknown }> {
  const sessionCookie = await getSessionCookie(kratosId)

  const flowRes = await fetch(`${KRATOS_PUBLIC_URL}/self-service/settings/browser`, {
    headers: { Accept: "application/json", Cookie: `ory_kratos_session=${sessionCookie}` },
  })
  if (!flowRes.ok) return { status: 500, data: { error: "flow_failed" } }
  const flow = await flowRes.json() as {
    id?: string
    ui?: { nodes?: { attributes?: { name?: string; value?: string } }[] }
  }
  if (!flow?.id) return { status: 500, data: { error: "invalid_flow" } }

  const csrfCookieKV = extractSetCookies(flowRes.headers)
    .map(c => c.split(";")[0])
    .find(c => c.startsWith("csrf_token")) ?? ""
  const csrfToken = flow.ui?.nodes?.find(n => n.attributes?.name === "csrf_token")?.attributes?.value ?? ""

  const hexCredentialId = Buffer.from(
    credentialId.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("hex")

  const removeNodes = flow.ui?.nodes?.filter(n => n.attributes?.name === "webauthn_remove") ?? []
  const matchedNode = removeNodes.find(n => n.attributes?.value === hexCredentialId || n.attributes?.value === credentialId)
  const removeValue = matchedNode?.attributes?.value ?? hexCredentialId

  const cookieHeader = [`ory_kratos_session=${sessionCookie}`, csrfCookieKV].filter(Boolean).join("; ")

  const res = await fetch(`${KRATOS_PUBLIC_URL}/self-service/settings?flow=${flow.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: cookieHeader },
    body: JSON.stringify({ method: "webauthn", webauthn_remove: removeValue, csrf_token: csrfToken }),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}
