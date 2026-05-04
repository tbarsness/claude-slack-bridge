import { config } from "./config.js";
import { buildApp } from "./slack.js";
import { initLog, log } from "./log.js";

async function main(): Promise<void> {
  initLog(config.logDir);
  log("starting", {
    assistants: config.assistants,
    default: config.defaultAssistant,
    channelMap: config.channelAssistants,
    allowed: config.allowedUserIds,
  });

  const app = buildApp();
  await app.start();
  log("ready (Socket Mode connected)");

  const shutdown = (sig: string) => {
    log("shutting down", { sig });
    app
      .stop()
      .catch((err) => log("stop error", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
