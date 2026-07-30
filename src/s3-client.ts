// Vendored from packages/shared/src/cdn/{s3-client,file.service}.ts (lumispace monorepo)
// — same tradeoff as include-cookie-frontend's own vendored copy: no shared package, just the ~70 lines
// this service actually needs (only saveFile, for the eager Telegram-avatar download).
import {
  S3Client, PutObjectCommand, CreateBucketCommand,
} from "@aws-sdk/client-s3"
import { config } from "./config.js"

const s3 = new S3Client({
  endpoint: config.s3Endpoint,
  region: "us-east-1",
  credentials: {
    accessKeyId: config.s3AccessKey,
    secretAccessKey: config.s3SecretKey,
  },
  forcePathStyle: true,
})

function s3ErrorCode(e: unknown): string | undefined {
  const err = e as { name?: string; Code?: string } | null
  return err?.name ?? err?.Code
}

export async function saveFile(
  buffer: Uint8Array,
  subCatalog: string,
  filename: string,
): Promise<string> {
  const put = () =>
    s3.send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: `${subCatalog}/${filename}`,
        Body: buffer,
        ContentType: "image/png",
      }),
    )

  try {
    await put()
  } catch (e) {
    // Self-heal a fresh object store: create the bucket on first use, then retry once.
    if (s3ErrorCode(e) !== "NoSuchBucket") throw e
    try {
      await s3.send(new CreateBucketCommand({ Bucket: config.s3Bucket }))
    } catch (ce) {
      const code = s3ErrorCode(ce)
      if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw ce
    }
    await put()
  }
  return filename
}
