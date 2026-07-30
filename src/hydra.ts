import { config } from "./config.js"

const ADMIN = config.hydraAdminUrl

async function adminFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Hydra admin request failed: ${init?.method ?? "GET"} ${path} -> ${res.status} ${body}`)
  }
  return res.json()
}

export interface HydraLoginRequest {
  skip: boolean
  subject: string
  client?: { client_id?: string }
  requested_scope?: string[]
}

export interface HydraConsentRequest {
  subject?: string
  client?: { client_id?: string }
  requested_scope?: string[]
  requested_access_token_audience?: string[]
}

export interface HydraRedirect {
  redirect_to: string
}

export function getLoginRequest(challenge: string): Promise<HydraLoginRequest> {
  return adminFetch(`/admin/oauth2/auth/requests/login?login_challenge=${encodeURIComponent(challenge)}`) as Promise<HydraLoginRequest>
}

export function acceptLoginRequest(challenge: string, body: {
  subject: string
  remember?: boolean
  remember_for?: number
}): Promise<HydraRedirect> {
  return adminFetch(`/admin/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(challenge)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }) as Promise<HydraRedirect>
}

export function getConsentRequest(challenge: string): Promise<HydraConsentRequest> {
  return adminFetch(`/admin/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(challenge)}`) as Promise<HydraConsentRequest>
}

export function acceptConsentRequest(challenge: string, body: {
  grant_scope?: string[]
  grant_access_token_audience?: string[]
  remember?: boolean
  remember_for?: number
  session?: { id_token?: Record<string, unknown> }
}): Promise<HydraRedirect> {
  return adminFetch(`/admin/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(challenge)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }) as Promise<HydraRedirect>
}

export function rejectConsentRequest(challenge: string, body: {
  error?: string
  error_description?: string
}): Promise<HydraRedirect> {
  return adminFetch(`/admin/oauth2/auth/requests/consent/reject?consent_challenge=${encodeURIComponent(challenge)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }) as Promise<HydraRedirect>
}

export function acceptLogoutRequest(challenge: string): Promise<HydraRedirect> {
  return adminFetch(`/admin/oauth2/auth/requests/logout/accept?logout_challenge=${encodeURIComponent(challenge)}`, {
    method: "PUT",
  }) as Promise<HydraRedirect>
}
