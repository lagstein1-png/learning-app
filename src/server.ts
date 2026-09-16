/**
 * Process entry point: load configuration, build the app, listen, and shut
 * down cleanly on SIGTERM/SIGINT so in-flight audio streams finish.
 */
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";

const config = loadConfig();
const { app, container } = createApp(config);
const { obs } = container;

const server = app.listen(config.port, () => {
  obs.info("server listening", {
    port: config.port,
    env: config.nodeEnv,
    gemini: container.preprocessor.aiEnabled,
    supabase: container.db !== null,
    azure: config.tts.azure.enabled,
    google: config.tts.google.enabled,
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  obs.info("shutdown requested", { signal });
  const forceExit = setTimeout(() => {
    obs.warn("forcing exit after grace period");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  server.close((err) => {
    if (err) {
      obs.error("server close failed", err);
      process.exit(1);
    }
    obs.info("server closed");
    process.exit(0);
  });
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("unhandledRejection", (reason) => {
  obs.error("unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
  obs.error("uncaught exception", error);
  shutdown("uncaughtException");
});
