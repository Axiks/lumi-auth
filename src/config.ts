// Env-driven config, read once at startup. Required vars throw immediately so a
// misconfigured container fails fast instead of running half-functional.
function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[auth] env ${name} is not set`)
  return v
}

export const config = {
  // Shared secret for the internal REST API (web/catalog → auth).
  internalKey: required("AUTH_INTERNAL_KEY"),
  kratosAdminUrl: process.env.KRATOS_ADMIN_URL || "http://localhost:4434",
  hydraAdminUrl: process.env.HYDRA_ADMIN_URL || "http://localhost:4445",
  botToken: required("BOT_TOKEN"),
  s3Endpoint: process.env.S3_ENDPOINT,
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "",
  s3Bucket: process.env.S3_BUCKET || "pandc",
  healthPort: Number(process.env.HEALTH_PORT || 8082),
}
