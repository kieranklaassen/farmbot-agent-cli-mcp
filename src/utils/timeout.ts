import { succeed, fail } from "../types/result.js";
import type { Result } from "../types/result.js";

interface TimeoutOpts {
  /**
   * If true, treat timeouts as "the bot is still running this on-device" rather than
   * a hard failure. Used for Lua and sequence execution, where the RPC ACK only
   * arrives after the script finishes — so a slow script looks like a timeout
   * even though everything is fine.
   */
  longRunning?: boolean;
}

/**
 * Wrap any promise with a timeout. farmbot-js has no built-in timeouts
 * on MQTT RPC commands — if the bot is off, the promise hangs forever.
 *
 * For long-running commands (Lua scripts, sequences) the bot only ACKs the
 * RPC once the script finishes. If the script takes longer than the timeout,
 * the user sees "TIMEOUT" but the bot is still happily executing. Set
 * `longRunning: true` so the error message reflects that.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  context: string,
  opts: TimeoutOpts = {},
): Promise<Result<T>> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms: ${context}`)),
      ms,
    );
  });

  try {
    const data = await Promise.race([promise, timeout]);
    clearTimeout(timer!);
    return succeed(data);
  } catch (err) {
    clearTimeout(timer!);
    const message =
      err instanceof Error ? err.message : `${context} failed: unknown error`;

    if (message.includes("Timeout")) {
      if (opts.longRunning) {
        return fail({
          code: "DEVICE_TIMEOUT",
          message: `${context} did not return within ${ms}ms — but the FarmBot may still be running it on-device. The RPC ACK only arrives after the script finishes; a long script looks like a timeout from here.`,
          retryable: false,
          hint: "Use farmbot_status to check `busy` and position. Use farmbot_logs to see toast messages and progress. Increase timeout_ms if the script genuinely needs longer.",
        });
      }
      return fail({
        code: "DEVICE_TIMEOUT",
        message: `${context} did not respond within ${ms}ms`,
        retryable: true,
        hint: "Check that FarmBot is powered on and connected to WiFi",
      });
    }

    return fail({
      code: "MQTT_ERROR",
      message,
      retryable: true,
      hint: "The device may be busy or temporarily unreachable",
    });
  }
}
