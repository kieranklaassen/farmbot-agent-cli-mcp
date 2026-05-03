#!/usr/bin/env node

import { Command } from "commander";
import type { Farmbot } from "farmbot";
import { z } from "zod";
import { EphemeralConnection, checkMoveRateLimit } from "./services/connection.js";
import { saveToken, clearConfig } from "./services/config.js";
import { withTimeout } from "./utils/timeout.js";
import {
  MoveParamsSchema,
  HomeParamsSchema,
  LuaParamsSchema,
  PinWriteSchema,
  PinReadSchema,
  PinToggleSchema,
  FindHomeSchema,
  CalibrateSchema,
  AddPlantParamsSchema,
  AddFarmEventParamsSchema,
} from "./types/schemas.js";
import { apiGet, apiPost, apiPatch, apiDelete } from "./services/api.js";
import { readDeviceState } from "./services/device-state.js";
import type { AppError, Result } from "./types/result.js";
import type { OutputEnvelope } from "./types/schemas.js";

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_SERVER = "https://my.farm.bot";

// ── Output helpers ──────────────────────────────────────────────────

function formatOutput<T>(
  command: string,
  result: Result<T>,
  json: boolean,
): void {
  if (json) {
    const envelope: OutputEnvelope<T> = result.ok
      ? { ok: true, command, data: result.data }
      : {
          ok: false,
          command,
          error: {
            code: result.error.code,
            message: result.error.message,
            retryable: result.error.retryable,
            hint: result.error.hint,
          },
        };
    console.log(JSON.stringify(envelope, null, 2));
  } else if (result.ok) {
    if (typeof result.data === "string") {
      console.log(result.data);
    } else {
      console.log(JSON.stringify(result.data, null, 2));
    }
  } else {
    printError(result.error);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function printError(error: AppError): void {
  console.error(`Error [${error.code}]: ${error.message}`);
  if (error.hint) {
    console.error(`Hint: ${error.hint}`);
  }
}

// ── Run a command with connection lifecycle ──────────────────────────

async function withConnection<T>(
  command: string,
  json: boolean,
  fn: (bot: Farmbot) => Promise<Result<T>>,
): Promise<void> {
  const conn = new EphemeralConnection();
  const connResult = await conn.acquire();
  if (!connResult.ok) {
    formatOutput(command, connResult, json);
    return;
  }

  try {
    const result = await fn(connResult.data);
    formatOutput(command, result, json);
  } finally {
    await conn.release();
  }
}

// ── CLI Setup ───────────────────────────────────────────────────────

const program = new Command()
  .name("farmbot")
  .description("Agent-native CLI for controlling FarmBot hardware")
  .version("0.1.0")
  .option("-j, --json", "Output as structured JSON", false)
  .option("-t, --timeout <ms>", "Command timeout in milliseconds", String(DEFAULT_TIMEOUT));

function getOpts(): { json: boolean; timeout: number } {
  const opts = program.opts<{ json: boolean; timeout: string }>();
  return { json: opts.json, timeout: parseInt(opts.timeout, 10) || DEFAULT_TIMEOUT };
}

// ── Commands ────────────────────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with FarmBot and store token")
  .requiredOption("--email <email>", "FarmBot account email")
  .requiredOption("--password <password>", "FarmBot account password")
  .option("--server <url>", "FarmBot server URL", DEFAULT_SERVER)
  .action(async (opts: { email: string; password: string; server: string }) => {
    const { json } = getOpts();
    try {
      const response = await fetch(`${opts.server}/api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: { email: opts.email, password: opts.password },
        }),
      });

      if (!response.ok) {
        formatOutput(
          "login",
          {
            ok: false,
            error: {
              code: "AUTH_MISSING" as const,
              message: `Authentication failed: ${response.status} ${response.statusText}`,
              retryable: false,
              hint: "Check your email and password",
            },
          },
          json,
        );
        return;
      }

      const TokenResponseSchema = z.object({
        token: z.object({
          encoded: z.string(),
          unencoded: z.object({ bot: z.string() }),
        }),
      });

      const parsed = TokenResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        formatOutput(
          "login",
          {
            ok: false,
            error: {
              code: "API_ERROR" as const,
              message: "Unexpected API response format",
              retryable: false,
              hint: "The FarmBot API may have changed. Try updating farmbot-agent.",
            },
          },
          json,
        );
        return;
      }

      const data = parsed.data;
      saveToken(data.token.encoded, opts.server);

      formatOutput(
        "login",
        {
          ok: true,
          data: `Authenticated as ${opts.email} (${data.token.unencoded.bot}). Token saved.`,
        },
        json,
      );
    } catch (err) {
      formatOutput(
        "login",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: err instanceof Error ? err.message : "Login failed",
            retryable: true,
            hint: `Check your network connection and server URL (${opts.server})`,
          },
        },
        json,
      );
    }
  });

program
  .command("logout")
  .description("Remove stored FarmBot token")
  .action(() => {
    const { json } = getOpts();
    clearConfig();
    formatOutput("logout", { ok: true, data: "Token removed." }, json);
  });

program
  .command("status")
  .description("Show FarmBot device status: position, state, firmware")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("status", json, async (bot) => {
      const statusResult = await withTimeout(bot.readStatus(), timeout, "Read device status");
      if (!statusResult.ok) return statusResult;

      const ds = await readDeviceState(bot);

      if (!json) {
        console.log(`Position: x=${ds.position.x} y=${ds.position.y} z=${ds.position.z}`);
        console.log(`State: ${ds.locked ? "e-stopped" : ds.busy ? "busy" : "idle"}`);
        console.log(`Firmware: ${ds.firmware}`);
      }

      return { ok: true as const, data: ds };
    });
  });

program
  .command("position")
  .description("Get current FarmBot gantry position (x, y, z in mm)")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("position", json, async (bot) => {
      const statusResult = await withTimeout(bot.readStatus(), timeout, "Read position");
      if (!statusResult.ok) return statusResult;
      return { ok: true as const, data: (await readDeviceState(bot)).position };
    });
  });

program
  .command("device-info")
  .description("Get device configuration: firmware, uptime, wifi")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("device-info", json, async (bot) => {
      const statusResult = await withTimeout(bot.readStatus(), timeout, "Read device info");
      if (!statusResult.ok) return statusResult;
      const ds = await readDeviceState(bot);
      return {
        ok: true as const,
        data: {
          controllerVersion: ds.controllerVersion,
          firmware: ds.firmware,
          busy: ds.busy,
          locked: ds.locked,
          uptime: ds.uptime,
          wifi: ds.wifi,
        },
      };
    });
  });

program
  .command("move")
  .description("Move FarmBot to a position (coordinates in mm)")
  .requiredOption("--x <mm>", "X coordinate")
  .requiredOption("--y <mm>", "Y coordinate")
  .requiredOption("--z <mm>", "Z coordinate")
  .option("-s, --speed <percent>", "Speed 1-100")
  .option("--relative", "Move relative to current position")
  .action(async (opts: { x: string; y: string; z: string; speed?: string; relative?: boolean }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("move", rateCheck, json);
      return;
    }

    const params = MoveParamsSchema.safeParse({
      x: parseFloat(opts.x),
      y: parseFloat(opts.y),
      z: parseFloat(opts.z),
      speed: opts.speed ? parseInt(opts.speed, 10) : undefined,
      relative: opts.relative,
    });

    if (!params.success) {
      formatOutput(
        "move",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("move", json, async (bot) => {
      const { x, y, z, speed, relative } = params.data;
      const moveSpeed = speed ?? 100;

      const result = relative
        ? await withTimeout(bot.moveRelative({ x, y, z, speed: moveSpeed }), timeout, "Move relative")
        : await withTimeout(bot.moveAbsolute({ x, y, z, speed: moveSpeed }), timeout, "Move absolute");

      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { moved: relative ? "relative" : "absolute", position: { x, y, z }, speed: moveSpeed },
      };
    });
  });

program
  .command("home")
  .description("Move FarmBot to home position (0, 0, 0)")
  .option("--axis <axis>", "Specific axis: x, y, z, or all", "all")
  .option("-s, --speed <percent>", "Speed 1-100", "100")
  .action(async (opts: { axis: string; speed: string }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("home", rateCheck, json);
      return;
    }

    const params = HomeParamsSchema.safeParse({
      axis: opts.axis,
      speed: parseInt(opts.speed, 10),
    });

    if (!params.success) {
      formatOutput(
        "home",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("home", json, async (bot) => {
      const { axis, speed } = params.data;
      const homeAxis = axis ?? "all";
      const result = await withTimeout(
        bot.home({ axis: homeAxis, speed: speed ?? 100 }),
        timeout,
        `Home ${homeAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { homed: homeAxis } };
    });
  });

program
  .command("e-stop")
  .alias("estop")
  .description("Emergency stop — immediately halt all FarmBot movement")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("e-stop", json, async (bot) => {
      const result = await withTimeout(bot.emergencyLock(), Math.min(timeout, 10_000), "Emergency stop");
      if (!result.ok) return result;
      return { ok: true as const, data: "Emergency stop activated. Run 'farmbot unlock' to resume." };
    });
  });

program
  .command("unlock")
  .description("Unlock FarmBot after an emergency stop")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("unlock", json, async (bot) => {
      const result = await withTimeout(bot.emergencyUnlock(), timeout, "Unlock");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device unlocked. Ready for commands." };
    });
  });

program
  .command("lua")
  .description("Execute Lua code on the FarmBot device")
  .argument("<code>", "Lua code to execute")
  .action(async (code: string) => {
    const { json, timeout } = getOpts();

    const params = LuaParamsSchema.safeParse({ code });
    if (!params.success) {
      formatOutput(
        "lua",
        {
          ok: false,
          error: {
            code: "LUA_ERROR" as const,
            message: "Invalid Lua code parameter",
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("lua", json, async (bot) => {
      const result = await withTimeout(bot.lua(params.data.code), timeout, "Lua execution", { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  });

// ── Pin/GPIO Commands ──────────────────────────────────────────────

const pinCmd = program
  .command("pin")
  .description("Read, write, or toggle GPIO pins");

pinCmd
  .command("write")
  .description("Write a value to a GPIO pin")
  .requiredOption("--pin <number>", "Pin number")
  .requiredOption("--value <number>", "Pin value (0/1 digital, 0-255 analog)")
  .option("--mode <mode>", "Pin mode: digital or analog", "digital")
  .action(async (opts: { pin: string; value: string; mode: string }) => {
    const { json, timeout } = getOpts();

    const params = PinWriteSchema.safeParse({
      pin: parseInt(opts.pin, 10),
      value: parseInt(opts.value, 10),
      mode: opts.mode,
    });

    if (!params.success) {
      formatOutput(
        "pin write",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("pin write", json, async (bot) => {
      const pinMode = params.data.mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.writePin({ pin_number: params.data.pin, pin_value: params.data.value, pin_mode: pinMode }),
        timeout,
        `Write pin ${params.data.pin}`,
      );
      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { pin: params.data.pin, value: params.data.value, mode: params.data.mode ?? "digital" },
      };
    });
  });

pinCmd
  .command("read")
  .description("Read the value of a GPIO pin")
  .requiredOption("--pin <number>", "Pin number")
  .option("--mode <mode>", "Pin mode: digital or analog", "digital")
  .action(async (opts: { pin: string; mode: string }) => {
    const { json, timeout } = getOpts();

    const params = PinReadSchema.safeParse({
      pin: parseInt(opts.pin, 10),
      mode: opts.mode,
    });

    if (!params.success) {
      formatOutput(
        "pin read",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("pin read", json, async (bot) => {
      const pinMode = params.data.mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.readPin({ pin_number: params.data.pin, pin_mode: pinMode, label: `pin_${params.data.pin}` }),
        timeout,
        `Read pin ${params.data.pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  });

pinCmd
  .command("toggle")
  .description("Toggle a GPIO pin between on and off")
  .requiredOption("--pin <number>", "Pin number")
  .action(async (opts: { pin: string }) => {
    const { json, timeout } = getOpts();

    const params = PinToggleSchema.safeParse({
      pin: parseInt(opts.pin, 10),
    });

    if (!params.success) {
      formatOutput(
        "pin toggle",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("pin toggle", json, async (bot) => {
      const result = await withTimeout(
        bot.togglePin({ pin_number: params.data.pin }),
        timeout,
        `Toggle pin ${params.data.pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { pin: params.data.pin, toggled: true } };
    });
  });

// ── Camera ────────────────────────────────────────────────────────

program
  .command("photo")
  .description("Take a photo with the FarmBot camera")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("photo", json, async (bot) => {
      const result = await withTimeout(bot.takePhoto(), timeout, "Take photo");
      if (!result.ok) return result;
      return { ok: true as const, data: "Photo captured." };
    });
  });

// ── Calibration ───────────────────────────────────────────────────

program
  .command("find-home")
  .description("Find home position using encoders or endstops")
  .option("--axis <axis>", "Axis: x, y, z, or all", "all")
  .option("-s, --speed <percent>", "Speed 1-100", "100")
  .action(async (opts: { axis: string; speed: string }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("find-home", rateCheck, json);
      return;
    }

    const params = FindHomeSchema.safeParse({
      axis: opts.axis,
      speed: parseInt(opts.speed, 10),
    });

    if (!params.success) {
      formatOutput(
        "find-home",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("find-home", json, async (bot) => {
      const findAxis = params.data.axis ?? "all";
      const result = await withTimeout(
        bot.findHome({ axis: findAxis, speed: params.data.speed ?? 100 }),
        timeout,
        `Find home ${findAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { foundHome: findAxis } };
    });
  });

program
  .command("calibrate")
  .description("Calibrate an axis by finding its length")
  .requiredOption("--axis <axis>", "Axis to calibrate: x, y, or z")
  .action(async (opts: { axis: string }) => {
    const { json, timeout } = getOpts();

    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      formatOutput("calibrate", rateCheck, json);
      return;
    }

    const params = CalibrateSchema.safeParse({ axis: opts.axis });

    if (!params.success) {
      formatOutput(
        "calibrate",
        {
          ok: false,
          error: {
            code: "POSITION_OUT_OF_BOUNDS" as const,
            message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
            retryable: false,
          },
        },
        json,
      );
      return;
    }

    await withConnection("calibrate", json, async (bot) => {
      const result = await withTimeout(
        bot.calibrate({ axis: params.data.axis }),
        timeout,
        `Calibrate ${params.data.axis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { calibrated: params.data.axis } };
    });
  });

// ── System ────────────────────────────────────────────────────────

program
  .command("sync")
  .description("Sync device with the FarmBot web app")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("sync", json, async (bot) => {
      const result = await withTimeout(bot.sync(), timeout, "Sync");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device synced." };
    });
  });

program
  .command("reboot")
  .description("Reboot the FarmBot device")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("reboot", json, async (bot) => {
      const result = await withTimeout(bot.reboot(), timeout, "Reboot");
      if (!result.ok) return result;
      return { ok: true as const, data: "Reboot initiated." };
    });
  });

// ── REST API Commands ──────────────────────────────────────────────

// Plants
const plantCmd = program
  .command("plants")
  .description("List all plants in the garden")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("points?filter=Plant");
    formatOutput("plants", result, json);
  });

program
  .command("plant")
  .description("Manage individual plants")
  .command("add")
  .description("Add a new plant to the garden")
  .requiredOption("--name <name>", "Plant name")
  .requiredOption("--x <mm>", "X coordinate")
  .requiredOption("--y <mm>", "Y coordinate")
  .option("--z <mm>", "Z coordinate", "0")
  .option("--radius <mm>", "Plant radius", "25")
  .option("--openfarm-slug <slug>", "OpenFarm crop slug")
  .action(
    async (opts: {
      name: string;
      x: string;
      y: string;
      z: string;
      radius: string;
      openfarmSlug?: string;
    }) => {
      const { json } = getOpts();

      const params = AddPlantParamsSchema.safeParse({
        name: opts.name,
        x: parseFloat(opts.x),
        y: parseFloat(opts.y),
        z: parseFloat(opts.z),
        radius: parseFloat(opts.radius),
        openfarm_slug: opts.openfarmSlug,
      });

      if (!params.success) {
        formatOutput(
          "plant add",
          {
            ok: false,
            error: {
              code: "API_ERROR" as const,
              message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
              retryable: false,
            },
          },
          json,
        );
        return;
      }

      const body = {
        pointer_type: "Plant",
        name: params.data.name,
        x: params.data.x,
        y: params.data.y,
        z: params.data.z,
        radius: params.data.radius,
        openfarm_slug: params.data.openfarm_slug ?? "",
      };

      const result = await apiPost("points", body);
      formatOutput("plant add", result, json);
    },
  );

program
  .command("plant-remove")
  .description("Remove a plant by ID")
  .argument("<id>", "Plant ID to remove")
  .action(async (id: string) => {
    const { json } = getOpts();
    const plantId = parseInt(id, 10);
    if (isNaN(plantId)) {
      formatOutput(
        "plant remove",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: "Invalid plant ID — must be a number",
            retryable: false,
          },
        },
        json,
      );
      return;
    }
    const result = await apiDelete(`points/${plantId}`);
    if (result.ok) {
      formatOutput("plant remove", { ok: true as const, data: `Plant ${plantId} removed.` }, json);
    } else {
      formatOutput("plant remove", result, json);
    }
  });

// Sequences
program
  .command("sequences")
  .description("List all sequences")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("sequences");
    formatOutput("sequences", result, json);
  });

program
  .command("sequence-run")
  .description("Run a sequence by ID (via MQTT)")
  .argument("<id>", "Sequence ID to run")
  .action(async (id: string) => {
    const { json, timeout } = getOpts();
    const seqId = parseInt(id, 10);
    if (isNaN(seqId)) {
      formatOutput(
        "sequence run",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: "Invalid sequence ID — must be a number",
            retryable: false,
          },
        },
        json,
      );
      return;
    }
    await withConnection("sequence run", json, async (bot) => {
      const result = await withTimeout(bot.execSequence(seqId), timeout, `Run sequence ${seqId}`, { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: { sequenceId: seqId, status: "completed" } };
    });
  });

// Tools
program
  .command("tools")
  .description("List all tools")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("tools");
    formatOutput("tools", result, json);
  });

// Peripherals
program
  .command("peripherals")
  .description("List all peripherals")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("peripherals");
    formatOutput("peripherals", result, json);
  });

// Sensors
program
  .command("sensors")
  .description("List all sensors")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("sensors");
    formatOutput("sensors", result, json);
  });

// Farm Events
program
  .command("events")
  .description("List all farm events")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown[]>("farm_events");
    formatOutput("events", result, json);
  });

program
  .command("event-add")
  .description("Create a new farm event")
  .requiredOption("--sequence-id <id>", "Sequence ID to run")
  .requiredOption("--start <datetime>", "Start time in ISO 8601 format")
  .option("--repeat <interval>", "Repeat: minutely, hourly, daily, weekly, monthly, yearly, never", "never")
  .option("--end <datetime>", "End time in ISO 8601 format")
  .action(
    async (opts: {
      sequenceId: string;
      start: string;
      repeat: string;
      end?: string;
    }) => {
      const { json } = getOpts();

      const params = AddFarmEventParamsSchema.safeParse({
        sequence_id: parseInt(opts.sequenceId, 10),
        start_time: opts.start,
        repeat: opts.repeat,
        end_time: opts.end,
      });

      if (!params.success) {
        formatOutput(
          "event add",
          {
            ok: false,
            error: {
              code: "API_ERROR" as const,
              message: `Invalid parameters: ${params.error.issues.map((i) => i.message).join(", ")}`,
              retryable: false,
            },
          },
          json,
        );
        return;
      }

      const body: Record<string, unknown> = {
        executable_id: params.data.sequence_id,
        executable_type: "Sequence",
        start_time: params.data.start_time,
        time_unit: params.data.repeat === "never" ? "never" : params.data.repeat,
        repeat: params.data.repeat === "never" ? 0 : 1,
      };

      if (params.data.end_time) {
        body["end_time"] = params.data.end_time;
      }

      const result = await apiPost("farm_events", body);
      formatOutput("event add", result, json);
    },
  );

program
  .command("event-remove")
  .description("Remove a farm event by ID")
  .argument("<id>", "Farm event ID to remove")
  .action(async (id: string) => {
    const { json } = getOpts();
    const eventId = parseInt(id, 10);
    if (isNaN(eventId)) {
      formatOutput(
        "event remove",
        {
          ok: false,
          error: {
            code: "API_ERROR" as const,
            message: "Invalid event ID — must be a number",
            retryable: false,
          },
        },
        json,
      );
      return;
    }
    const result = await apiDelete(`farm_events/${eventId}`);
    if (result.ok) {
      formatOutput("event remove", { ok: true as const, data: `Farm event ${eventId} removed.` }, json);
    } else {
      formatOutput("event remove", result, json);
    }
  });

// Device (REST API)
program
  .command("device")
  .description("Show device configuration from the REST API")
  .action(async () => {
    const { json } = getOpts();
    const result = await apiGet<unknown>("device");
    formatOutput("device", result, json);
  });

// ── Helper: simple list-style commands (REST GET) ───────────────────

function addListCommand(name: string, path: string, description: string): void {
  program
    .command(name)
    .description(description)
    .action(async () => {
      const { json } = getOpts();
      const result = await apiGet<unknown>(path);
      formatOutput(name, result, json);
    });
}

function addGetByIdCommand(name: string, path: (id: number) => string, description: string): void {
  program
    .command(name)
    .description(description)
    .argument("<id>", "Resource ID")
    .action(async (id: string) => {
      const { json } = getOpts();
      const idNum = parseInt(id, 10);
      if (isNaN(idNum)) {
        formatOutput(name, { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
        return;
      }
      const result = await apiGet<unknown>(path(idNum));
      formatOutput(name, result, json);
    });
}

function addDeleteByIdCommand(name: string, path: (id: number) => string, description: string): void {
  program
    .command(name)
    .description(description)
    .argument("<id>", "Resource ID")
    .action(async (id: string) => {
      const { json } = getOpts();
      const idNum = parseInt(id, 10);
      if (isNaN(idNum)) {
        formatOutput(name, { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
        return;
      }
      const result = await apiDelete(path(idNum));
      if (result.ok) {
        formatOutput(name, { ok: true as const, data: `Deleted (id: ${idNum}).` }, json);
      } else {
        formatOutput(name, result, json);
      }
    });
}

// ── Points / weeds ──────────────────────────────────────────────────

program
  .command("points")
  .description("List points (plants, weeds, generic markers, tool slots). Use --type to filter.")
  .option("--type <pointer_type>", "Plant | Weed | GenericPointer | ToolSlot")
  .action(async (opts: { type?: string }) => {
    const { json } = getOpts();
    const path = opts.type ? `points?filter=${opts.type}` : "points";
    const result = await apiGet<unknown>(path);
    formatOutput("points", result, json);
  });

program
  .command("point-add")
  .description("Add a Weed or GenericPointer point")
  .requiredOption("--type <pointer_type>", "Weed | GenericPointer")
  .requiredOption("--name <name>", "Point name")
  .requiredOption("--x <mm>", "X coordinate")
  .requiredOption("--y <mm>", "Y coordinate")
  .option("--z <mm>", "Z coordinate", "0")
  .option("--radius <mm>", "Radius", "25")
  .action(async (opts: { type: string; name: string; x: string; y: string; z: string; radius: string }) => {
    const { json } = getOpts();
    const result = await apiPost("points", {
      pointer_type: opts.type,
      name: opts.name,
      x: parseFloat(opts.x),
      y: parseFloat(opts.y),
      z: parseFloat(opts.z),
      radius: parseFloat(opts.radius),
      meta: {},
    });
    formatOutput("point add", result, json);
  });

addDeleteByIdCommand("point-remove", (id) => `points/${id}`, "Remove a point by ID");

program
  .command("plant-update")
  .description("Update a plant's attributes")
  .argument("<id>", "Plant ID")
  .option("--name <name>")
  .option("--x <mm>")
  .option("--y <mm>")
  .option("--z <mm>")
  .option("--radius <mm>")
  .option("--openfarm-slug <slug>")
  .option("--plant-stage <stage>", "planned | planted | sprouted | harvested | removed | active")
  .option("--planted-at <iso>", "ISO 8601 timestamp")
  .action(async (id: string, opts: Record<string, string | undefined>) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("plant update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    const changes: Record<string, unknown> = {};
    if (opts["name"] !== undefined) changes["name"] = opts["name"];
    if (opts["x"] !== undefined) changes["x"] = parseFloat(opts["x"]);
    if (opts["y"] !== undefined) changes["y"] = parseFloat(opts["y"]);
    if (opts["z"] !== undefined) changes["z"] = parseFloat(opts["z"]);
    if (opts["radius"] !== undefined) changes["radius"] = parseFloat(opts["radius"]);
    if (opts["openfarmSlug"] !== undefined) changes["openfarm_slug"] = opts["openfarmSlug"];
    if (opts["plantStage"] !== undefined) changes["plant_stage"] = opts["plantStage"];
    if (opts["plantedAt"] !== undefined) changes["planted_at"] = opts["plantedAt"];
    const result = await apiPatch(`points/${idNum}`, changes);
    formatOutput("plant update", result, json);
  });

addListCommand("point-groups", "point_groups", "List point groups");

// ── Images ──────────────────────────────────────────────────────────

program
  .command("images")
  .description("List photos taken by the FarmBot camera")
  .option("--limit <n>", "Max images to return")
  .action(async (opts: { limit?: string }) => {
    const { json } = getOpts();
    const path = opts.limit ? `images?per_page=${parseInt(opts.limit, 10)}` : "images";
    const result = await apiGet<unknown>(path);
    formatOutput("images", result, json);
  });

addGetByIdCommand("image", (id) => `images/${id}`, "Get a single image by ID (returns URL + metadata)");
addDeleteByIdCommand("image-remove", (id) => `images/${id}`, "Delete an image by ID");

// ── Logs ────────────────────────────────────────────────────────────

program
  .command("logs")
  .description("List FarmBot device logs (toast messages, errors, lifecycle)")
  .option("--type <type>", "info | success | warn | error | busy | fun | debug | assertion")
  .option("--verbosity <n>", "0-3")
  .option("--limit <n>", "Max log entries")
  .action(async (opts: { type?: string; verbosity?: string; limit?: string }) => {
    const { json } = getOpts();
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    if (opts.verbosity !== undefined) params.set("verbosity", opts.verbosity);
    if (opts.limit) params.set("per_page", opts.limit);
    const qs = params.toString();
    const result = await apiGet<unknown>(`logs${qs ? `?${qs}` : ""}`);
    formatOutput("logs", result, json);
  });

// ── Read endpoints ──────────────────────────────────────────────────

addListCommand("sensor-readings", "sensor_readings", "List recorded sensor readings");
addListCommand("curves", "curves", "List water/spread/height curves");
addGetByIdCommand("curve", (id) => `curves/${id}`, "Get a single curve by ID");
addListCommand("alerts", "alerts", "List active alerts");
addListCommand("farmwares", "farmware_installations", "List installed farmwares");
addListCommand("farmware-envs", "farmware_envs", "List farmware env vars (camera calibration, weed detector thresholds)");
addListCommand("diagnostic-dumps", "diagnostic_dumps", "List diagnostic dumps (may 404 on some servers)");
addListCommand("telemetry", "telemetries", "List telemetry samples");
addListCommand("saved-gardens", "saved_gardens", "List saved gardens");
addListCommand("plant-templates", "plant_templates", "List plant_templates (members of saved gardens)");

// Farmware env upsert
program
  .command("farmware-env-set")
  .description("Set a farmware env var (upsert by key)")
  .requiredOption("--key <key>")
  .requiredOption("--value <value>")
  .action(async (opts: { key: string; value: string }) => {
    const { json } = getOpts();
    const result = await apiPost("farmware_envs", { key: opts.key, value: opts.value });
    formatOutput("farmware-env-set", result, json);
  });

// ── Configs (R/W) ───────────────────────────────────────────────────

function addConfigCommands(name: string, path: string, description: string): void {
  program
    .command(`${name}-get`)
    .description(`Get ${description}`)
    .action(async () => {
      const { json } = getOpts();
      const result = await apiGet<unknown>(path);
      formatOutput(`${name} get`, result, json);
    });
  program
    .command(`${name}-patch`)
    .description(`Patch ${description}. Pass --values as JSON.`)
    .requiredOption("--values <json>", "JSON object of changed values")
    .action(async (opts: { values: string }) => {
      const { json } = getOpts();
      let parsed: unknown;
      try {
        parsed = JSON.parse(opts.values);
      } catch {
        formatOutput(`${name} patch`, { ok: false, error: { code: "API_ERROR" as const, message: "--values must be valid JSON", retryable: false } }, json);
        return;
      }
      const result = await apiPatch(path, parsed);
      formatOutput(`${name} patch`, result, json);
    });
}

addConfigCommands("firmware-config", "firmware_config", "firmware config (axis lengths, motor speeds)");
addConfigCommands("fbos-config", "fbos_config", "FarmBot OS config");
addConfigCommands("web-app-config", "web_app_config", "web app config");

// ── Regimens ────────────────────────────────────────────────────────

addListCommand("regimens", "regimens", "List all regimens (recurring schedules)");
addGetByIdCommand("regimen", (id) => `regimens/${id}`, "Get a regimen by ID with its regimen_items");

program
  .command("regimen-add")
  .description("Create a regimen. Pass --items as JSON: [{sequence_id, time_offset}, ...]")
  .requiredOption("--name <name>")
  .option("--color <color>", "blue|green|yellow|orange|purple|pink|gray|red", "gray")
  .requiredOption("--items <json>", "JSON array of regimen_items")
  .action(async (opts: { name: string; color: string; items: string }) => {
    const { json } = getOpts();
    let items: unknown;
    try {
      items = JSON.parse(opts.items);
    } catch {
      formatOutput("regimen add", { ok: false, error: { code: "API_ERROR" as const, message: "--items must be valid JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPost("regimens", {
      name: opts.name,
      color: opts.color,
      regimen_items: items,
      body: [],
    });
    formatOutput("regimen add", result, json);
  });

program
  .command("regimen-update")
  .description("Update a regimen. Pass --changes as JSON.")
  .argument("<id>", "Regimen ID")
  .requiredOption("--changes <json>", "JSON object of changes")
  .action(async (id: string, opts: { changes: string }) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("regimen update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    let changes: unknown;
    try {
      changes = JSON.parse(opts.changes);
    } catch {
      formatOutput("regimen update", { ok: false, error: { code: "API_ERROR" as const, message: "--changes must be valid JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPatch(`regimens/${idNum}`, changes);
    formatOutput("regimen update", result, json);
  });

addDeleteByIdCommand("regimen-remove", (id) => `regimens/${id}`, "Delete a regimen by ID");

// ── Sequences (CRUD) ────────────────────────────────────────────────

addGetByIdCommand("sequence", (id) => `sequences/${id}`, "Get a sequence by ID");

program
  .command("sequence-add")
  .description("Create a sequence. --body is JSON CeleryScript array.")
  .requiredOption("--name <name>")
  .option("--color <color>", "blue|green|yellow|orange|purple|pink|gray|red", "gray")
  .requiredOption("--body <json>", "JSON array of step objects")
  .option("--args <json>", "Optional locals/args JSON")
  .action(async (opts: { name: string; color: string; body: string; args?: string }) => {
    const { json } = getOpts();
    let body: unknown, argsObj: unknown;
    try {
      body = JSON.parse(opts.body);
      argsObj = opts.args ? JSON.parse(opts.args) : { version: 20180209, locals: { kind: "scope_declaration", args: {} } };
    } catch {
      formatOutput("sequence add", { ok: false, error: { code: "API_ERROR" as const, message: "--body / --args must be valid JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPost("sequences", { name: opts.name, color: opts.color, body, args: argsObj });
    formatOutput("sequence add", result, json);
  });

program
  .command("sequence-update")
  .description("Update a sequence. --changes JSON.")
  .argument("<id>", "Sequence ID")
  .requiredOption("--changes <json>")
  .action(async (id: string, opts: { changes: string }) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("sequence update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    let changes: unknown;
    try { changes = JSON.parse(opts.changes); } catch {
      formatOutput("sequence update", { ok: false, error: { code: "API_ERROR" as const, message: "--changes must be valid JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPatch(`sequences/${idNum}`, changes);
    formatOutput("sequence update", result, json);
  });

addDeleteByIdCommand("sequence-remove", (id) => `sequences/${id}`, "Delete a sequence by ID");

// ── Point groups (CRUD) ─────────────────────────────────────────────

addGetByIdCommand("point-group", (id) => `point_groups/${id}`, "Get a point group by ID");

program
  .command("point-group-add")
  .description("Create a point group with given member point IDs")
  .requiredOption("--name <name>")
  .requiredOption("--point-ids <csv>", "Comma-separated point IDs")
  .option("--sort-type <type>", "xy_ascending|yx_ascending|xy_descending|yx_descending|random|nn", "xy_ascending")
  .action(async (opts: { name: string; pointIds: string; sortType: string }) => {
    const { json } = getOpts();
    const ids = opts.pointIds.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    const result = await apiPost("point_groups", {
      name: opts.name,
      point_ids: ids,
      sort_type: opts.sortType,
      criteria: { day: { op: "<", days_ago: 0 }, string_eq: {}, number_eq: {}, number_lt: {}, number_gt: {} },
    });
    formatOutput("point-group add", result, json);
  });

program
  .command("point-group-update")
  .description("Update a point group. --changes JSON.")
  .argument("<id>")
  .requiredOption("--changes <json>")
  .action(async (id: string, opts: { changes: string }) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("point-group update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    let changes: unknown;
    try { changes = JSON.parse(opts.changes); } catch {
      formatOutput("point-group update", { ok: false, error: { code: "API_ERROR" as const, message: "--changes must be JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPatch(`point_groups/${idNum}`, changes);
    formatOutput("point-group update", result, json);
  });

addDeleteByIdCommand("point-group-remove", (id) => `point_groups/${id}`, "Delete a point group by ID");

// ── point-update (generic) + event-update ───────────────────────────

program
  .command("point-update")
  .description("Update any point's attributes (use plant-update for plants for plant_stage)")
  .argument("<id>")
  .option("--name <name>")
  .option("--x <mm>")
  .option("--y <mm>")
  .option("--z <mm>")
  .option("--radius <mm>")
  .action(async (id: string, opts: Record<string, string | undefined>) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("point update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    const changes: Record<string, unknown> = {};
    if (opts["name"] !== undefined) changes["name"] = opts["name"];
    if (opts["x"] !== undefined) changes["x"] = parseFloat(opts["x"]);
    if (opts["y"] !== undefined) changes["y"] = parseFloat(opts["y"]);
    if (opts["z"] !== undefined) changes["z"] = parseFloat(opts["z"]);
    if (opts["radius"] !== undefined) changes["radius"] = parseFloat(opts["radius"]);
    const result = await apiPatch(`points/${idNum}`, changes);
    formatOutput("point update", result, json);
  });

program
  .command("event-update")
  .description("Update a farm event. --changes JSON.")
  .argument("<id>")
  .requiredOption("--changes <json>")
  .action(async (id: string, opts: { changes: string }) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("event update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    let changes: unknown;
    try { changes = JSON.parse(opts.changes); } catch {
      formatOutput("event update", { ok: false, error: { code: "API_ERROR" as const, message: "--changes must be JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPatch(`farm_events/${idNum}`, changes);
    formatOutput("event update", result, json);
  });

// ── Tools / peripherals / sensors (CRUD) ────────────────────────────

program
  .command("tool-add")
  .description("Register a tool")
  .requiredOption("--name <name>")
  .option("--flow-rate <ml/s>", "Flow rate in mL/s for watering tools")
  .action(async (opts: { name: string; flowRate?: string }) => {
    const { json } = getOpts();
    const result = await apiPost("tools", {
      name: opts.name,
      flow_rate_ml_per_s: opts.flowRate ? parseFloat(opts.flowRate) : 0,
    });
    formatOutput("tool add", result, json);
  });

program
  .command("tool-update")
  .description("Update a tool. --changes JSON.")
  .argument("<id>")
  .requiredOption("--changes <json>")
  .action(async (id: string, opts: { changes: string }) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("tool update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    let changes: unknown;
    try { changes = JSON.parse(opts.changes); } catch {
      formatOutput("tool update", { ok: false, error: { code: "API_ERROR" as const, message: "--changes must be JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPatch(`tools/${idNum}`, changes);
    formatOutput("tool update", result, json);
  });

addDeleteByIdCommand("tool-remove", (id) => `tools/${id}`, "Delete a tool by ID");

program
  .command("peripheral-add")
  .description("Register a peripheral on a GPIO pin")
  .requiredOption("--pin <pin>")
  .requiredOption("--label <label>")
  .option("--mode <mode>", "0 (digital) or 1 (analog)", "0")
  .action(async (opts: { pin: string; label: string; mode: string }) => {
    const { json } = getOpts();
    const result = await apiPost("peripherals", {
      pin: parseInt(opts.pin, 10),
      label: opts.label,
      mode: parseInt(opts.mode, 10),
    });
    formatOutput("peripheral add", result, json);
  });

program
  .command("peripheral-update")
  .description("Update a peripheral. --changes JSON.")
  .argument("<id>")
  .requiredOption("--changes <json>")
  .action(async (id: string, opts: { changes: string }) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("peripheral update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    let changes: unknown;
    try { changes = JSON.parse(opts.changes); } catch {
      formatOutput("peripheral update", { ok: false, error: { code: "API_ERROR" as const, message: "--changes must be JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPatch(`peripherals/${idNum}`, changes);
    formatOutput("peripheral update", result, json);
  });

addDeleteByIdCommand("peripheral-remove", (id) => `peripherals/${id}`, "Delete a peripheral by ID");

program
  .command("sensor-add")
  .description("Register a sensor on a GPIO pin")
  .requiredOption("--pin <pin>")
  .requiredOption("--label <label>")
  .option("--mode <mode>", "0 (digital) or 1 (analog)", "0")
  .action(async (opts: { pin: string; label: string; mode: string }) => {
    const { json } = getOpts();
    const result = await apiPost("sensors", {
      pin: parseInt(opts.pin, 10),
      label: opts.label,
      mode: parseInt(opts.mode, 10),
    });
    formatOutput("sensor add", result, json);
  });

program
  .command("sensor-update")
  .description("Update a sensor. --changes JSON.")
  .argument("<id>")
  .requiredOption("--changes <json>")
  .action(async (id: string, opts: { changes: string }) => {
    const { json } = getOpts();
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      formatOutput("sensor update", { ok: false, error: { code: "API_ERROR" as const, message: "ID must be a number", retryable: false } }, json);
      return;
    }
    let changes: unknown;
    try { changes = JSON.parse(opts.changes); } catch {
      formatOutput("sensor update", { ok: false, error: { code: "API_ERROR" as const, message: "--changes must be JSON", retryable: false } }, json);
      return;
    }
    const result = await apiPatch(`sensors/${idNum}`, changes);
    formatOutput("sensor update", result, json);
  });

addDeleteByIdCommand("sensor-remove", (id) => `sensors/${id}`, "Delete a sensor by ID");

// ── execute_script + high-level setup ───────────────────────────────

program
  .command("execute-script")
  .description("Run an installed farmware on-device by label")
  .argument("<label>", "Farmware label (e.g. camera-calibration, plant-detection)")
  .option("--env <key=value...>", "Pass env var(s)", (v: string, prev: string[] = []) => [...prev, v], [] as string[])
  .action(async (label: string, opts: { env: string[] }) => {
    const { json, timeout } = getOpts();
    const envPairs = opts.env.length
      ? opts.env.map((kv) => {
          const idx = kv.indexOf("=");
          if (idx < 0) return null;
          return { kind: "pair" as const, args: { label: kv.slice(0, idx), value: kv.slice(idx + 1) } };
        }).filter(Boolean) as Array<{ kind: "pair"; args: { label: string; value: string } }>
      : undefined;
    await withConnection("execute-script", json, async (bot) => {
      const result = await withTimeout(bot.execScript(label, envPairs), timeout, `Run farmware ${label}`, { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: { farmware: label, status: "started" } };
    });
  });

program
  .command("calibrate-camera")
  .description("Run the camera calibration farmware (~30s)")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("calibrate-camera", json, async (bot) => {
      const result = await withTimeout(bot.execScript("camera-calibration"), timeout, "Camera calibration", { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: "Camera calibration started. Results saved to farmware_envs (CAMERA_CALIBRATION_*)." };
    });
  });

program
  .command("measure-soil-height")
  .description("Measure soil height at the current position")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("measure-soil-height", json, async (bot) => {
      const result = await withTimeout(bot.execScript("measure-soil-height"), timeout, "Measure soil height", { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: "Soil height measurement started." };
    });
  });

program
  .command("detect-weeds")
  .description("Run plant/weed detection on the latest photo at the current position")
  .action(async () => {
    const { json, timeout } = getOpts();
    await withConnection("detect-weeds", json, async (bot) => {
      const result = await withTimeout(bot.execScript("plant-detection"), timeout, "Weed detection", { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: "Weed detection started. Detected weeds saved as Weed points." };
    });
  });

program.parse();
