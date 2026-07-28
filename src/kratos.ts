import { config } from "./config.js"

const ADMIN = config.kratosAdminUrl

export interface KratosProfileLink {
  name: string
  url: string
}

export interface KratosIdentity {
  kratosId: string
  tgId: string | null
  nickname: string | null
  about: string | null
  avatarUrl: string | null
  coverUrl: string | null
  links: KratosProfileLink[]
  role: string | null
  createdAt: string | null
}

interface KratosTraits {
  telegram_id?: string
  nickname?: string
  avatar_url?: string
  cover_url?: string
  about?: string
  links?: { name?: string; url?: string }[]
  role?: string
}

interface KratosIdentityRecord {
  id: string
  schema_id?: string
  state?: string
  traits?: KratosTraits
  created_at?: string
}

function mapRecord(rec: KratosIdentityRecord): KratosIdentity {
  const traits = rec.traits ?? {}
  const links = (traits.links ?? [])
    .filter((l): l is { name?: string; url: string } => typeof l?.url === "string" && l.url.length > 0)
    .map(l => ({ name: l.name ?? "", url: l.url }))
  return {
    kratosId: rec.id,
    tgId: traits.telegram_id ?? null,
    nickname: traits.nickname ?? null,
    about: traits.about ?? null,
    avatarUrl: traits.avatar_url ?? null,
    coverUrl: traits.cover_url ?? null,
    links,
    role: traits.role ?? null,
    createdAt: rec.created_at ?? null,
  }
}

export async function getIdentity(kratosId: string): Promise<KratosIdentity | null> {
  const res = await fetch(`${ADMIN}/admin/identities/${encodeURIComponent(kratosId)}`, { cache: "no-store" })
  if (!res.ok) return null
  const data = await res.json() as KratosIdentityRecord
  return mapRecord(data)
}

// Read-modify-write trait merge — never clobbers telegram_id or any field not in `patch`.
// avatarUrl/coverUrl are stored exactly as given (bare filename, typically) — this service
// has no concept of a calling app's public origin, so it never does URL-prefixing; that's
// each caller's job at display/claims time (matching apps/catalog's existing convention).
export async function updateTraits(kratosId: string, patch: {
  nickname?: string
  about?: string | null
  avatarUrl?: string | null
  coverUrl?: string | null
  links?: KratosProfileLink[]
  role?: string
}): Promise<boolean> {
  const res = await fetch(`${ADMIN}/admin/identities/${encodeURIComponent(kratosId)}`, { cache: "no-store" })
  if (!res.ok) return false
  const identity = await res.json() as KratosIdentityRecord
  const traits: KratosTraits = { ...(identity.traits ?? {}) }

  if (patch.nickname !== undefined) traits.nickname = patch.nickname
  if (patch.about !== undefined) traits.about = patch.about ?? undefined
  if (patch.avatarUrl !== undefined) traits.avatar_url = patch.avatarUrl ?? undefined
  if (patch.coverUrl !== undefined) traits.cover_url = patch.coverUrl ?? undefined
  if (patch.links !== undefined) traits.links = patch.links.map(l => ({ name: l.name, url: l.url }))
  if (patch.role !== undefined) traits.role = patch.role

  const put = await fetch(`${ADMIN}/admin/identities/${encodeURIComponent(kratosId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ schema_id: identity.schema_id, state: identity.state ?? "active", traits }),
  })
  return put.ok
}

// Permanently delete a Kratos identity (account). 404 is treated as already-gone (idempotent).
export async function deleteIdentity(kratosId: string): Promise<boolean> {
  const res = await fetch(`${ADMIN}/admin/identities/${encodeURIComponent(kratosId)}`, {
    method: "DELETE",
    cache: "no-store",
  })
  return res.ok || res.status === 404
}

export async function createIdentity(params: {
  tgId: string
  nickname: string
  avatarFilename?: string | null
}): Promise<string> {
  const res = await fetch(`${ADMIN}/admin/identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      schema_id: "default",
      traits: {
        telegram_id: params.tgId,
        nickname: params.nickname,
        ...(params.avatarFilename ? { avatar_url: params.avatarFilename } : {}),
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Kratos create identity failed: ${res.status} ${body}`)
  }
  const identity = await res.json() as { id: string }
  return identity.id
}

// No caching here — this service is a stateless proxy; callers own any caching they want
// (mirrors how pandc-web already wraps its identity-list calls in unstable_cache today).
async function listAllIdentities(): Promise<KratosIdentityRecord[]> {
  const res = await fetch(`${ADMIN}/admin/identities?per_page=500&page_size=500`, { cache: "no-store" })
  if (!res.ok) {
    console.error("[kratos] list identities failed:", res.status)
    return []
  }
  const data = await res.json()
  return Array.isArray(data) ? data : (data.identities ?? [])
}

// Same shape as KratosIdentity — kept as a separate name for callers that conceptually
// want "a user summary" rather than "the identity I asked for by id".
export type WebUserSummary = KratosIdentity

function toSummary(rec: KratosIdentityRecord): WebUserSummary {
  return mapRecord(rec)
}

export async function findByTgId(tgId: string): Promise<WebUserSummary | null> {
  const list = await listAllIdentities()
  const match = list.find(i => i.traits?.telegram_id === tgId)
  return match ? toSummary(match) : null
}

export async function findByNickname(nickname: string): Promise<{ kratosId: string; tgId: string } | null> {
  const list = await listAllIdentities()
  const nicknameLC = nickname.trim().toLowerCase()
  const match = list.find(i => (i.traits?.nickname ?? "").toLowerCase() === nicknameLC)
  if (!match?.traits?.telegram_id) return null
  return { kratosId: match.id, tgId: match.traits.telegram_id }
}

export async function listOrSearch(q?: string): Promise<WebUserSummary[]> {
  const list = await listAllIdentities()
  if (!q) return list.map(toSummary)
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return list.filter(i => (i.traits?.nickname ?? "").toLowerCase().includes(needle)).map(toSummary)
}

export async function batchProfiles(ids: string[]): Promise<Record<string, WebUserSummary>> {
  if (ids.length === 0) return {}
  const want = new Set(ids)
  const list = await listAllIdentities()
  const out: Record<string, WebUserSummary> = {}
  for (const rec of list) {
    if (want.has(rec.id)) out[rec.id] = toSummary(rec)
  }
  return out
}

export interface KratosPasskey {
  id: string
  display_name: string
  added_at: string
}

// Lists a user's registered WebAuthn passkeys (id + display name + added date) — used by
// the security settings page. Returns [] on any error.
export async function listPasskeys(kratosId: string): Promise<KratosPasskey[]> {
  try {
    const res = await fetch(
      `${ADMIN}/admin/identities/${encodeURIComponent(kratosId)}?include_credential=webauthn`,
      { cache: "no-store" },
    )
    if (!res.ok) return []
    const data = await res.json() as {
      credentials?: { webauthn?: { config?: { credentials?: KratosPasskey[] } } }
    }
    return data.credentials?.webauthn?.config?.credentials ?? []
  } catch {
    return []
  }
}
