import { startApi } from "./api.js"

const server = startApi()

async function shutdown(): Promise<void> {
  console.log("[auth] shutting down")
  server.close()
  process.exit(0)
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
