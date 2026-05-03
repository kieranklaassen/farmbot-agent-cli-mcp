import { Farmbot } from "farmbot";
import { loadToken } from "./config.js";
import { attachStatusCache } from "./device-state.js";
import { fail, succeed } from "../types/result.js";
import type { Result } from "../types/result.js";

/**
 * ConnectionManager handles the MQTT lifecycle mismatch between
 * CLI (one-shot) and MCP (long-lived) modes.
 *
 * farmbot-js has no disconnect() method. To cleanly exit in CLI mode,
 * we force-close the underlying mqtt.js client socket.
 */

export interface ConnectionManager {
  acquire(): Promise<Result<Farmbot>>;
  release(): Promise<void>;
}

/**
 * EphemeralConnection: for CLI mode.
 * Creates a new connection, used for one command, then force-closed.
 */
export class EphemeralConnection implements ConnectionManager {
  private bot: Farmbot | null = null;

  async acquire(): Promise<Result<Farmbot>> {
    const token = loadToken();
    if (!token) {
      return fail({
        code: "AUTH_MISSING",
        message: "No FarmBot token found",
        retryable: false,
        hint: "Run 'farmbot login' or set FARMBOT_TOKEN environment variable",
      });
    }

    try {
      this.bot = new Farmbot({ token });
      attachStatusCache(this.bot);
      await this.bot.connect();
      return succeed(this.bot);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to connect to FarmBot";
      return fail({
        code: "MQTT_ERROR",
        message,
        retryable: true,
        hint: "Check your token and internet connection",
      });
    }
  }

  async release(): Promise<void> {
    if (this.bot) {
      // farmbot-js has no disconnect() — force-close the mqtt.js socket
      // to prevent auto-reconnect from holding the Node.js event loop open
      const client = (this.bot as unknown as { client?: { end: (force: boolean) => void } }).client;
      if (client) {
        client.end(true);
      }
      this.bot = null;
    }
  }
}

/**
 * PersistentConnection: for MCP mode.
 * Lazy-connects on first tool call, reuses across the session.
 */
export class PersistentConnection implements ConnectionManager {
  private bot: Farmbot | null = null;
  private connectPromise: Promise<Result<Farmbot>> | null = null;

  async acquire(): Promise<Result<Farmbot>> {
    if (this.bot) {
      return succeed(this.bot);
    }

    // If already connecting, let concurrent callers await the same promise
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    const result = await this.connectPromise;
    this.connectPromise = null;
    return result;
  }

  private async doConnect(): Promise<Result<Farmbot>> {
    const token = loadToken();
    if (!token) {
      return fail({
        code: "AUTH_MISSING",
        message: "No FarmBot token found",
        retryable: false,
        hint: "Set FARMBOT_TOKEN environment variable before starting the MCP server",
      });
    }

    try {
      this.bot = new Farmbot({ token });
      attachStatusCache(this.bot);
      await this.bot.connect();

      // Handle disconnection — clear the instance so next acquire() reconnects
      this.bot.on("offline", () => {
        console.error("[farmbot-agent] Device went offline, will reconnect on next command");
        this.bot = null;
      });

      return succeed(this.bot);
    } catch (err) {
      this.bot = null;
      const message =
        err instanceof Error ? err.message : "Failed to connect to FarmBot";
      return fail({
        code: "MQTT_ERROR",
        message,
        retryable: true,
        hint: "Check FARMBOT_TOKEN and internet connection",
      });
    }
  }

  async release(): Promise<void> {
    if (this.bot) {
      const client = (this.bot as unknown as { client?: { end: (force: boolean) => void } }).client;
      if (client) {
        client.end(true);
      }
      this.bot = null;
    }
  }
}

/** Sliding window rate limiter — configurable via env vars */
const WINDOW_MS = 60_000;
const moveTimestamps: number[] = [];

function getMoveRateLimit(): number {
  const raw = process.env["FARMBOT_MOVE_RATE_LIMIT"];
  if (!raw) return 30;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export function checkMoveRateLimit(): Result<void> {
  const limit = getMoveRateLimit();
  const now = Date.now();
  // Remove timestamps outside the window
  while (moveTimestamps.length > 0 && (moveTimestamps[0] ?? 0) <= now - WINDOW_MS) {
    moveTimestamps.shift();
  }
  if (moveTimestamps.length >= limit) {
    return fail({
      code: "RATE_LIMITED",
      message: `Rate limit exceeded: ${limit} moves per ${WINDOW_MS / 1000}s window. Override with FARMBOT_MOVE_RATE_LIMIT env var.`,
      retryable: true,
      hint: "Wait a few seconds before sending more move commands, or raise FARMBOT_MOVE_RATE_LIMIT (default 30).",
    });
  }
  moveTimestamps.push(now);
  return succeed(undefined);
}
