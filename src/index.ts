import { config } from "./config.js";
import { buildApp, sessionStore } from "./slack.js";
import { initLog, log } from "./log.js";
import { startVoiceEndpoint } from "./voice-endpoint.js";
import { startBoardEndpoint } from "./board-endpoint.js";

const DISCONNECT_GRACE_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

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

  // Hands-free voice queries from the iOS Shortcut, over Tailscale only.
  startVoiceEndpoint({ client: app.client, sessions: sessionStore });

  // Dispatches from the shared task board, over Tailscale only.
  startBoardEndpoint({ client: app.client, sessions: sessionStore });

  // Watchdog: Bolt has been observed to drop the socket silently (pong
  // timeouts without firing 'disconnected'). Exit on disconnect signals AND on
  // a periodic auth.test failure; launchd KeepAlive respawns us cleanly.
  const appAny = app as unknown as {
    receiver?: {
      client?: {
        on?: (event: string, cb: (...args: unknown[]) => void) => void;
      };
    };
  };
  const socket = appAny.receiver?.client;
  let downSince: number | null = null;
  if (socket && typeof socket.on === "function") {
    socket.on("connected", () => {
      if (downSince !== null) {
        log("socket reconnected", { downForMs: Date.now() - downSince });
      }
      downSince = null;
    });
    socket.on("disconnected", () => {
      if (downSince === null) downSince = Date.now();
      log("socket disconnected");
    });
    socket.on("unable_to_socket_mode_start", (...args: unknown[]) => {
      log("socket unable_to_start, exiting", { err: String(args[0] ?? "") });
      process.exit(2);
    });
  }

  const watchdog = setInterval(() => {
    if (downSince !== null && Date.now() - downSince > DISCONNECT_GRACE_MS) {
      log("socket down too long, exiting", { ms: Date.now() - downSince });
      process.exit(2);
    }
  }, 5_000);
  watchdog.unref();

  // Only restart after several consecutive heartbeat failures. A single
  // transient auth.test blip is not worth a restart — and rapid restarts stack
  // WebSocket connections, which Slack rejects with `too_many_websockets`,
  // causing more churn and more dropped inbound messages than the blip itself.
  const HEARTBEAT_FAILS_BEFORE_EXIT = 3;
  let heartbeatFails = 0;
  const heartbeat = setInterval(async () => {
    try {
      const r = await app.client.auth.test();
      if (!r.ok) throw new Error(String(r.error ?? "auth.test not ok"));
      heartbeatFails = 0;
    } catch (err) {
      heartbeatFails += 1;
      const msg = err instanceof Error ? err.message : String(err);
      log("heartbeat failed", { err: msg, consecutive: heartbeatFails });
      if (heartbeatFails >= HEARTBEAT_FAILS_BEFORE_EXIT) {
        log("heartbeat failed repeatedly, exiting", {
          consecutive: heartbeatFails,
        });
        process.exit(2);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

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
