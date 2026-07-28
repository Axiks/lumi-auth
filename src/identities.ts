import { createIdentity, findByTgId, updateTraits } from "./kratos.js"
import { downloadAvatarToS3, type VerifiedTelegramUser } from "./telegram.js"

// Finds the Kratos identity for a verified Telegram user, creating one on first login.
// On creation: eagerly downloads the Telegram photo (if present) to S3, and sets a
// `t.me/<username>` profile link (if a username was present). Returning users are left
// untouched except backfilling a missing avatar.
export async function findOrCreateFromTelegram(
  user: VerifiedTelegramUser,
): Promise<{ kratosId: string; isNew: boolean }> {
  const existing = await findByTgId(user.tgId)

  if (!existing) {
    const avatarFilename = user.photoUrl ? await downloadAvatarToS3(user.photoUrl) : null
    const kratosId = await createIdentity({
      tgId: user.tgId,
      nickname: user.username ?? user.displayName,
      avatarFilename,
    })
    if (user.username) {
      await updateTraits(kratosId, {
        links: [{ name: "t.me/" + user.username, url: "https://t.me/" + user.username }],
      })
    }
    return { kratosId, isNew: true }
  }

  if (user.photoUrl && !existing.avatarUrl) {
    const avatarFilename = await downloadAvatarToS3(user.photoUrl)
    if (avatarFilename) await updateTraits(existing.kratosId, { avatarUrl: avatarFilename })
  }

  return { kratosId: existing.kratosId, isNew: false }
}
