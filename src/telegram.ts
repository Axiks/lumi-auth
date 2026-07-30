import { createHash, createHmac, randomUUID } from "node:crypto"
import { validate, parse } from "@tma.js/init-data-node"
import { config } from "./config.js"
import { saveFile } from "./s3-client.js"

export interface VerifiedTelegramUser {
  tgId: string
  username?: string
  displayName: string
  photoUrl?: string
}

export class TelegramVerifyError extends Error {
  constructor(public code: "invalid_hash" | "expired" | "invalid_init_data" | "no_user") {
    super(code)
  }
}

// Verifies the hash sent by the Telegram Login Widget.
// https://core.telegram.org/widgets/login#checking-authorization
export function verifyWidget(params: Record<string, string>): VerifiedTelegramUser {
  const hash = params["hash"]
  if (!hash) throw new TelegramVerifyError("invalid_hash")

  const dataCheckString = Object.keys(params)
    .filter(k => k !== "hash" && params[k] !== undefined)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("\n")
  const secretKey = createHash("sha256").update(config.botToken).digest()
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest("hex")
  if (expected !== hash) throw new TelegramVerifyError("invalid_hash")

  const authDate = Number(params["auth_date"])
  if (!authDate || Date.now() / 1000 - authDate > 86400) throw new TelegramVerifyError("expired")

  if (!params["id"]) throw new TelegramVerifyError("no_user")
  return {
    tgId: params["id"],
    username: params["username"],
    displayName: [params["first_name"], params["last_name"]].filter(Boolean).join(" "),
    photoUrl: params["photo_url"],
  }
}

// Verifies a Telegram Mini App initData string.
export function verifyMiniapp(initData: string): VerifiedTelegramUser {
  try {
    validate(initData, config.botToken, { expiresIn: 86400 })
  } catch {
    throw new TelegramVerifyError("invalid_init_data")
  }
  const data = parse(initData)
  const tgUser = data.user
  if (!tgUser) throw new TelegramVerifyError("no_user")
  return {
    tgId: String(tgUser.id),
    username: tgUser.username,
    displayName: [tgUser.firstName, tgUser.lastName].filter(Boolean).join(" "),
    photoUrl: tgUser.photoUrl as string | undefined,
  }
}

// Thin wrapper over Telegram's getChatMember — no authorization decision here, callers
// (each app's own chat-gate) decide which statuses count as "a member".
export async function getChatMember(chatId: string, userId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: userId }),
    })
    const data = await res.json() as { ok: boolean; result?: { status?: string } }
    if (!data.ok) return null
    return data.result?.status ?? null
  } catch (e) {
    console.error("[telegram] getChatMember failed:", e)
    return null
  }
}

// Downloads a Telegram-hosted avatar file and saves it to S3, returning the stored filename.
// Returns null on any failure (registration proceeds without an avatar).
export async function downloadAvatarToS3(photoUrl: string): Promise<string | null> {
  try {
    const response = await fetch(photoUrl)
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const filename = randomUUID() + ".png"
    await saveFile(buffer, "avatars", filename)
    return filename
  } catch (e) {
    console.warn("[telegram] avatar download failed:", e)
    return null
  }
}

// Fetches a Telegram user's CURRENT profile photo bytes on demand (no photo_url in hand,
// unlike the login-time widget/miniapp flows above) — used for the "refresh avatar from
// Telegram" action. getChat -> big_file_id -> getFile -> download.
export async function getAvatarBytesByTgId(tgId: string): Promise<{ bytes: Uint8Array; ext: string } | null> {
  try {
    const chatRes = await fetch(
      `https://api.telegram.org/bot${config.botToken}/getChat?chat_id=${encodeURIComponent(tgId)}`,
    )
    if (!chatRes.ok) return null
    const chat = await chatRes.json() as { ok: boolean; result?: { photo?: { big_file_id?: string } } }
    const fileId = chat.result?.photo?.big_file_id
    if (!fileId) return null

    const fileRes = await fetch(
      `https://api.telegram.org/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    )
    if (!fileRes.ok) return null
    const file = await fileRes.json() as { ok: boolean; result?: { file_path?: string } }
    const path = file.result?.file_path
    if (!path) return null

    const imgRes = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${path}`)
    if (!imgRes.ok) return null
    const bytes = new Uint8Array(await imgRes.arrayBuffer())
    const ext = (path.split(".").pop() || "jpg").toLowerCase()
    return { bytes, ext }
  } catch (e) {
    console.warn("[telegram] getAvatarBytesByTgId failed:", e)
    return null
  }
}
