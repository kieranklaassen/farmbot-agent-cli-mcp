#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PersistentConnection, checkMoveRateLimit } from "./services/connection.js";
import { withTimeout } from "./utils/timeout.js";
import { readDeviceState } from "./services/device-state.js";
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
  UpdatePlantParamsSchema,
  ResourceByIdSchema,
  RunSequenceParamsSchema,
  AddFarmEventParamsSchema,
  ListImagesParamsSchema,
  ListLogsParamsSchema,
  ListPointsParamsSchema,
  AddPointParamsSchema,
  ConfigPatchSchema,
  FarmwareEnvUpsertSchema,
  ExecuteScriptSchema,
  AddRegimenParamsSchema,
  UpdateRegimenParamsSchema,
  UpdatePointParamsSchema,
  AddSequenceParamsSchema,
  UpdateSequenceParamsSchema,
  AddPointGroupParamsSchema,
  UpdatePointGroupParamsSchema,
  UpdateFarmEventParamsSchema,
  AddToolParamsSchema,
  UpdateToolParamsSchema,
  AddPeripheralParamsSchema,
  UpdatePeripheralParamsSchema,
  AddSensorParamsSchema,
  UpdateSensorParamsSchema,
} from "./types/schemas.js";
import { apiGet, apiPost, apiPatch, apiDelete } from "./services/api.js";
import type { Farmbot } from "farmbot";
import type { Result } from "./types/result.js";

const DEFAULT_TIMEOUT = 30_000;
const connection = new PersistentConnection();

// ── Helpers ─────────────────────────────────────────────────────────

type ToolResult = {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean | undefined;
};

function mcpError(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function mcpOk(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

async function withBot<T>(
  fn: (bot: Farmbot) => Promise<Result<T>>,
): Promise<ToolResult> {
  const connResult = await connection.acquire();
  if (!connResult.ok) {
    return mcpError(`${connResult.error.message}${connResult.error.hint ? ` (${connResult.error.hint})` : ""}`);
  }

  const result = await fn(connResult.data);
  if (!result.ok) {
    return mcpError(`[${result.error.code}] ${result.error.message}${result.error.hint ? `. ${result.error.hint}` : ""}`);
  }

  if (typeof result.data === "string") {
    return mcpOk(result.data);
  }
  return mcpOk(JSON.stringify(result.data, null, 2));
}

// ── MCP Server Setup ────────────────────────────────────────────────

const server = new McpServer(
  { name: "farmbot-agent", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

// ── Tools ───────────────────────────────────────────────────────────

server.tool(
  "farmbot_status",
  `Get the current FarmBot device status: position, state, firmware version.

Returns position (x, y, z in mm), busy flag, locked flag, firmware/controller versions.

Call this:
- Before any movement command (don't move while busy=true).
- To follow long-running Lua/sequences after a timeout.
For deeper context use the farmbot://device/capabilities or recent-activity resources.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read status");
      return { ok: true as const, data: await readDeviceState(bot) };
    });
  },
);

server.tool(
  "farmbot_get_position",
  `Get just the current X, Y, Z position of the FarmBot gantry in millimeters.

Lighter than farmbot_status — use when you only need coordinates.
X runs along the bed length, Y across the width, Z is height (0 = top, negative = into soil).`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read position");
      return { ok: true as const, data: (await readDeviceState(bot)).position };
    });
  },
);

server.tool(
  "farmbot_move",
  `Move the FarmBot gantry to a position in the garden.

Coordinates are in millimeters from the home position (0,0,0).
- X: along the length of the bed (0 to ~3000mm for standard, ~6000mm for XL)
- Y: across the width of the bed (0 to ~1500mm for standard, ~3000mm for XL)
- Z: height (0 = top, negative = into soil, e.g. -50 for planting depth)

Set relative=true to move relative to current position instead of absolute.
Returns the target position after movement completes.`,
  MoveParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ x, y, z, speed, relative }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const moveSpeed = speed ?? 100;
      const result = relative
        ? await withTimeout(bot.moveRelative({ x, y, z, speed: moveSpeed }), DEFAULT_TIMEOUT, "Move relative")
        : await withTimeout(bot.moveAbsolute({ x, y, z, speed: moveSpeed }), DEFAULT_TIMEOUT, "Move absolute");

      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { moved: relative ? "relative" : "absolute", position: { x, y, z }, speed: moveSpeed },
      };
    });
  },
);

server.tool(
  "farmbot_home",
  `Move FarmBot to the home position (0, 0, 0) or home a specific axis.

Homes using the device's configured home-finding method (encoders or endstops).
After homing, the position is reset to 0 on the homed axis.`,
  HomeParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ axis, speed }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const homeAxis = axis ?? "all";
      const result = await withTimeout(
        bot.home({ axis: homeAxis, speed: speed ?? 100 }),
        DEFAULT_TIMEOUT,
        `Home ${homeAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { homed: homeAxis } };
    });
  },
);

server.tool(
  "farmbot_emergency_stop",
  `EMERGENCY STOP — immediately halt all FarmBot movement and lock the device.

Use when something is going wrong — a collision, unexpected behavior, or safety concern.
The device will be locked until farmbot_unlock is called.
This is the highest priority command and should always be available.`,
  {},
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.emergencyLock(), 10_000, "Emergency stop");
      if (!result.ok) return result;
      return { ok: true as const, data: "Emergency stop activated. Device is locked. Call farmbot_unlock to resume." };
    });
  },
);

server.tool(
  "farmbot_unlock",
  `Unlock the FarmBot device after an emergency stop.

After calling farmbot_emergency_stop, the device is locked and will not respond
to movement commands. Call this to unlock and resume normal operation.`,
  {},
  { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.emergencyUnlock(), DEFAULT_TIMEOUT, "Unlock");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device unlocked. Ready for commands." };
    });
  },
);

server.tool(
  "farmbot_get_device_info",
  `Get device configuration and identification info.

Returns the controller version, firmware version, uptime, and wifi signal.
Useful for understanding the FarmBot model and capabilities.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      await withTimeout(bot.readStatus(), DEFAULT_TIMEOUT, "Read device info");
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
  },
);

server.tool(
  "farmbot_lua",
  `Execute Lua code directly on the FarmBot device.

This is an escape hatch for advanced operations not covered by other tools.
The FarmBot Lua runtime includes functions for movement, pins, photos, and more.

Example: move{x=100, y=200, z=0}
Example: water(plant_id)
Example: take_photo()

WARNING: This executes arbitrary code on the device. Use with caution.`,
  LuaParamsSchema.shape,
  { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async ({ code, timeout_ms }) => {
    return withBot(async (bot) => {
      const wait = timeout_ms ?? DEFAULT_TIMEOUT;
      const result = await withTimeout(bot.lua(code), wait, "Lua execution", { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  },
);

// ── Pin/GPIO Tools ────────────────────────────────────────────────

server.tool(
  "farmbot_write_pin",
  `Write a value to a GPIO pin on the FarmBot.

Sets a pin to a specific value. Use digital mode (0 or 1) for on/off control
of peripherals like the water valve or vacuum pump. Use analog mode (0-255)
for variable output like LED brightness.`,
  PinWriteSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ pin, value, mode }) => {
    return withBot(async (bot) => {
      const pinMode = mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.writePin({ pin_number: pin, pin_value: value, pin_mode: pinMode }),
        DEFAULT_TIMEOUT,
        `Write pin ${pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { pin, value, mode: mode ?? "digital" } };
    });
  },
);

server.tool(
  "farmbot_read_pin",
  `Read the current value of a GPIO pin on the FarmBot.

Returns the pin value. Digital mode returns 0 or 1, analog mode returns 0-255.
Use this to check sensor readings or peripheral states.`,
  PinReadSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ pin, mode }) => {
    return withBot(async (bot) => {
      const pinMode = mode === "analog" ? 1 : 0;
      const result = await withTimeout(
        bot.readPin({ pin_number: pin, pin_mode: pinMode, label: `pin_${pin}` }),
        DEFAULT_TIMEOUT,
        `Read pin ${pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: result.data };
    });
  },
);

server.tool(
  "farmbot_toggle_pin",
  `Toggle a GPIO pin between on (1) and off (0).

Flips the current digital state of the pin. If the pin is on, it turns off, and vice versa.
Useful for quickly switching peripherals like lights or the water valve.`,
  PinToggleSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ pin }) => {
    return withBot(async (bot) => {
      const result = await withTimeout(
        bot.togglePin({ pin_number: pin }),
        DEFAULT_TIMEOUT,
        `Toggle pin ${pin}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { pin, toggled: true } };
    });
  },
);

// ── Camera ────────────────────────────────────────────────────────

server.tool(
  "farmbot_take_photo",
  `Take a photo with the FarmBot camera.

Triggers the onboard camera to capture an image. The photo is saved to the
FarmBot web app and can be viewed in the photos panel.
Use this for plant monitoring, weed detection, or garden documentation.`,
  {},
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.takePhoto(), DEFAULT_TIMEOUT, "Take photo");
      if (!result.ok) return result;
      return { ok: true as const, data: "Photo captured." };
    });
  },
);

// ── Calibration ───────────────────────────────────────────────────

server.tool(
  "farmbot_find_home",
  `Find the home position using encoders or endstops.

Moves the specified axis (or all axes) until it hits an endstop or stall-detection
triggers, then sets that position as 0. This is more thorough than farmbot_home
which simply moves to the stored 0 position.`,
  FindHomeSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ axis, speed }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const findAxis = axis ?? "all";
      const result = await withTimeout(
        bot.findHome({ axis: findAxis, speed: speed ?? 100 }),
        DEFAULT_TIMEOUT,
        `Find home ${findAxis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { foundHome: findAxis } };
    });
  },
);

server.tool(
  "farmbot_calibrate",
  `Calibrate an axis by finding its total length (motion calibration, NOT camera).

Moves the axis to both endpoints to determine the full range of motion.
After calibration the axis length is written to firmware_config — verify with
farmbot_get_firmware_config (movement_axis_nr_steps_*).

Prereq: run farmbot_find_home first so the bot knows where 0 is.
For camera calibration use farmbot_execute_script({label:'camera-calibration'}).`,
  CalibrateSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ axis }) => {
    const rateCheck = checkMoveRateLimit();
    if (!rateCheck.ok) {
      return mcpError(`[${rateCheck.error.code}] ${rateCheck.error.message}`);
    }

    return withBot(async (bot) => {
      const result = await withTimeout(
        bot.calibrate({ axis }),
        DEFAULT_TIMEOUT,
        `Calibrate ${axis}`,
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { calibrated: axis } };
    });
  },
);

// ── System ────────────────────────────────────────────────────────

server.tool(
  "farmbot_sync",
  `Sync the FarmBot device with the web application.

Triggers the device to download the latest data from the FarmBot web app,
including sequences, farm events, and device settings. Run this after making
changes via the REST API to ensure the device has the latest configuration.`,
  {},
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.sync(), DEFAULT_TIMEOUT, "Sync");
      if (!result.ok) return result;
      return { ok: true as const, data: "Device synced." };
    });
  },
);

server.tool(
  "farmbot_reboot",
  `Reboot the FarmBot device.

Restarts the FarmBot OS. The device will be offline for 1-2 minutes during reboot.
Use this to recover from stuck states or apply firmware updates.
The MQTT connection will be lost and must be re-established after reboot.`,
  {},
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async () => {
    return withBot(async (bot) => {
      const result = await withTimeout(bot.reboot(), DEFAULT_TIMEOUT, "Reboot");
      if (!result.ok) return result;
      return { ok: true as const, data: "Reboot initiated." };
    });
  },
);

// ── REST API Tools ─────────────────────────────────────────────────

/** Helper for REST-only tools (no MQTT connection needed) */
async function restResult<T>(result: Result<T>): Promise<ToolResult> {
  if (!result.ok) {
    return mcpError(`[${result.error.code}] ${result.error.message}${result.error.hint ? `. ${result.error.hint}` : ""}`);
  }
  if (typeof result.data === "string") {
    return mcpOk(result.data);
  }
  return mcpOk(JSON.stringify(result.data, null, 2));
}

// Plants

server.tool(
  "farmbot_list_plants",
  `List all plants in the FarmBot garden.

Returns an array of plant points with their names, positions, and OpenFarm slugs.
Use this to understand the current garden layout before planning operations.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("points?filter=Plant")),
);

server.tool(
  "farmbot_add_plant",
  `Add a plant to the FarmBot garden.

Coordinates in millimeters. Optionally pass an OpenFarm slug for crop info.

Common follow-ups:
- After it sprouts: farmbot_update_plant({id, plant_stage:'sprouted'}).
- To water on a recurring basis: build a regimen via farmbot_add_regimen,
  bind it to plants via a FarmEvent (farmbot_add_farm_event with executable_type='Regimen').
Check existing layout first with farmbot_list_plants to avoid duplicates.`,
  AddPlantParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ name, x, y, z, radius, openfarm_slug }) => {
    const body = {
      pointer_type: "Plant",
      name,
      x,
      y,
      z: z ?? 0,
      radius: radius ?? 25,
      openfarm_slug: openfarm_slug ?? "",
    };
    return restResult(await apiPost("points", body));
  },
);

server.tool(
  "farmbot_remove_plant",
  `Remove a plant from the FarmBot garden by its ID.

Permanently deletes the plant point. Use farmbot_list_plants first to find the ID.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const result = await apiDelete(`points/${id}`);
    if (result.ok) return mcpOk(`Plant ${id} removed.`);
    return restResult(result);
  },
);

// Sequences

server.tool(
  "farmbot_list_sequences",
  `List all saved sequences on the FarmBot.

Returns sequence names, IDs, and metadata. Use the ID with farmbot_run_sequence to execute one.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("sequences")),
);

server.tool(
  "farmbot_run_sequence",
  `Execute a saved sequence on the FarmBot device via MQTT.

Runs the sequence identified by ID. The sequence must already exist on the device.
Use farmbot_list_sequences to find available sequence IDs.
This command blocks until the sequence completes or times out.`,
  RunSequenceParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ id, timeout_ms }) => {
    return withBot(async (bot) => {
      const wait = timeout_ms ?? DEFAULT_TIMEOUT;
      const result = await withTimeout(bot.execSequence(id), wait, `Run sequence ${id}`, { longRunning: true });
      if (!result.ok) return result;
      return { ok: true as const, data: { sequenceId: id, status: "completed" } };
    });
  },
);

// Tools

server.tool(
  "farmbot_list_tools",
  `List all tools configured on the FarmBot.

Returns tool names, IDs, and slot assignments. Tools include items like the seeder,
watering nozzle, weeder, and soil sensor.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("tools")),
);

// Peripherals

server.tool(
  "farmbot_list_peripherals",
  `List all peripherals configured on the FarmBot.

Returns peripheral names, IDs, pin numbers, and modes. Peripherals include
the water valve, vacuum pump, lighting, and other connected hardware.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("peripherals")),
);

// Sensors

server.tool(
  "farmbot_list_sensors",
  `List all sensors configured on the FarmBot.

Returns sensor names, IDs, pin numbers, and modes. Sensors include
the soil moisture sensor, tool verification sensor, and other inputs.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("sensors")),
);

// Farm Events

server.tool(
  "farmbot_list_farm_events",
  `List all scheduled farm events.

Returns event configurations including the executable (sequence/regimen),
schedule, start/end times, and repeat intervals.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("farm_events")),
);

server.tool(
  "farmbot_add_farm_event",
  `Create a new scheduled farm event.

Schedules a sequence to run at a specific time, optionally repeating on an interval.
Use farmbot_list_sequences first to find the sequence ID.`,
  AddFarmEventParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ sequence_id, start_time, repeat, end_time }) => {
    const body: Record<string, unknown> = {
      executable_id: sequence_id,
      executable_type: "Sequence",
      start_time,
      time_unit: repeat === "never" ? "never" : repeat,
      repeat: repeat === "never" ? 0 : 1,
    };
    if (end_time) {
      body["end_time"] = end_time;
    }
    return restResult(await apiPost("farm_events", body));
  },
);

server.tool(
  "farmbot_remove_farm_event",
  `Remove a scheduled farm event by its ID.

Permanently deletes the event. Use farmbot_list_farm_events first to find the ID.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const result = await apiDelete(`farm_events/${id}`);
    if (result.ok) return mcpOk(`Farm event ${id} removed.`);
    return restResult(result);
  },
);

// Device

server.tool(
  "farmbot_get_device_config",
  `Get the device configuration from the FarmBot REST API.

Returns the full device record including name, timezone, firmware config,
and other settings. This is the REST API device config, not the MQTT live status.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("device")),
);

// ── Plants (update) ───────────────────────────────────────────────

server.tool(
  "farmbot_update_plant",
  `Update an existing plant's attributes.

Use this to change a plant's name, position, plant_stage (planned/planted/sprouted/harvested/removed),
or planted_at timestamp. Pass only the fields you want to change.`,
  UpdatePlantParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => {
    return restResult(await apiPatch(`points/${id}`, changes));
  },
);

// ── Points (generic — weeds, generic markers) ─────────────────────

server.tool(
  "farmbot_list_points",
  `List points in the FarmBot. Points represent plants, weeds, generic markers, or tool slots.

Pass pointer_type to filter (Plant | Weed | GenericPointer | ToolSlot). Omit to get everything.
For plants only, prefer farmbot_list_plants which filters server-side.`,
  ListPointsParamsSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ pointer_type }) => {
    const path = pointer_type ? `points?filter=${pointer_type}` : "points";
    return restResult(await apiGet(path));
  },
);

server.tool(
  "farmbot_add_point",
  `Add a Weed or GenericPointer point to the FarmBot.

Use Weed for weeds detected by the camera/agent that you want the bot to mow or remove.
Use GenericPointer for arbitrary markers (soil samples, obstacles, locations).`,
  AddPointParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ pointer_type, name, x, y, z, radius, meta }) => {
    return restResult(
      await apiPost("points", {
        pointer_type,
        name,
        x,
        y,
        z: z ?? 0,
        radius: radius ?? 25,
        meta: meta ?? {},
      }),
    );
  },
);

server.tool(
  "farmbot_remove_point",
  `Remove any point (plant, weed, generic marker) by ID.

Permanently deletes the point. Tool slots cannot be removed via this tool.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const result = await apiDelete(`points/${id}`);
    if (result.ok) return mcpOk(`Point ${id} removed.`);
    return restResult(result);
  },
);

server.tool(
  "farmbot_list_point_groups",
  `List all point groups (named collections of plants/weeds/points).

Point groups are used as targets for sequences and regimens — e.g. "all tomatoes",
"weeds in zone A". Returns IDs and member point IDs.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("point_groups")),
);

// ── Images ────────────────────────────────────────────────────────

server.tool(
  "farmbot_list_images",
  `List photos taken by the FarmBot camera.

Returns image records with URLs, capture coordinates, and metadata. Use the URL to view
or download the image. Sort order is most-recent first; use limit to bound results.`,
  ListImagesParamsSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ limit }) => {
    const path = limit ? `images?per_page=${limit}` : "images";
    return restResult(await apiGet(path));
  },
);

server.tool(
  "farmbot_get_image",
  `Get a single image record by ID, including its public URL and capture metadata.`,
  ResourceByIdSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id }) => restResult(await apiGet(`images/${id}`)),
);

server.tool(
  "farmbot_remove_image",
  `Delete a single image by ID.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const result = await apiDelete(`images/${id}`);
    if (result.ok) return mcpOk(`Image ${id} removed.`);
    return restResult(result);
  },
);

// ── Logs ──────────────────────────────────────────────────────────

server.tool(
  "farmbot_list_logs",
  `List FarmBot device logs. Logs include status messages, toast notifications from Lua scripts,
errors, and lifecycle events.

Filter by type (info, success, warn, error, busy, fun, debug, assertion) and verbosity (0-3).
Use this to follow a long-running Lua script or sequence — toast() messages appear here.`,
  ListLogsParamsSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ type, verbosity, limit }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (verbosity !== undefined) params.set("verbosity", String(verbosity));
    if (limit) params.set("per_page", String(limit));
    const qs = params.toString();
    return restResult(await apiGet(`logs${qs ? `?${qs}` : ""}`));
  },
);

// ── Sensor readings ───────────────────────────────────────────────

server.tool(
  "farmbot_list_sensor_readings",
  `List sensor readings recorded by the FarmBot. Includes soil moisture probe values,
tool verification reads, and any pin reads taken during sequences.

Returns readings with timestamps, pin numbers, modes, and values.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("sensor_readings")),
);

// ── Curves (water/spread/height) ──────────────────────────────────

server.tool(
  "farmbot_list_curves",
  `List water/spread/height curves used by plants for adaptive watering.

Each plant can reference a water_curve_id, spread_curve_id, height_curve_id which
defines values across the plant's lifecycle.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("curves")),
);

server.tool(
  "farmbot_get_curve",
  `Get a single curve by ID.`,
  ResourceByIdSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id }) => restResult(await apiGet(`curves/${id}`)),
);

// ── Alerts ────────────────────────────────────────────────────────

server.tool(
  "farmbot_list_alerts",
  `List active alerts (e.g. firmware out of date, no setup completed, no soil height yet).
The web app uses these for setup wizards and notifications.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("alerts")),
);

// ── Farmwares ─────────────────────────────────────────────────────

server.tool(
  "farmbot_list_farmwares",
  `List installed farmwares (on-device plugins like camera-calibration, plant-detection,
measure-soil-height). Use the label with farmbot_execute_script to run one.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("farmware_installations")),
);

server.tool(
  "farmbot_list_farmware_envs",
  `List farmware env vars. Camera calibration values (CAMERA_CALIBRATION_coord_scale,
CAMERA_CALIBRATION_camera_z, CAMERA_CALIBRATION_image_bot_origin_location, etc.) and
WEED_DETECTOR_* values are stored here.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("farmware_envs")),
);

server.tool(
  "farmbot_set_farmware_env",
  `Set or update a farmware env var by key (upsert).

Use this to override camera calibration values, weed detector thresholds, or any other
on-device config. Always stored as a string.`,
  FarmwareEnvUpsertSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ key, value }) => {
    return restResult(await apiPost("farmware_envs", { key, value }));
  },
);

// ── Config (firmware/fbos/web_app) ────────────────────────────────

server.tool(
  "farmbot_get_firmware_config",
  `Get firmware config: motor settings, axis lengths, accelerations, encoder behaviour,
homing speeds, safe heights. This is what you change to calibrate motion.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("firmware_config")),
);

server.tool(
  "farmbot_patch_firmware_config",
  `Update firmware config values. Pass only the keys you want to change in 'values'.

Common keys: movement_axis_nr_steps_x/y/z (axis length in steps),
movement_max_spd_x/y/z, movement_min_spd_x/y/z, movement_steps_acc_dec_x/y/z,
encoder_enabled_x/y/z, movement_home_spd_x/y/z, movement_invert_motor_x/y/z.

Run farmbot_sync after to apply on-device.`,
  ConfigPatchSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ values }) => restResult(await apiPatch("firmware_config", values)),
);

server.tool(
  "farmbot_get_fbos_config",
  `Get FarmBot OS config: photo settings, soil height fallback, auto-update flags,
sequence cancellation behaviour.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("fbos_config")),
);

server.tool(
  "farmbot_patch_fbos_config",
  `Update FarmBot OS config values. Pass only the keys you want to change in 'values'.

Common keys: auto_sync (bool), beta_opt_in (bool), disable_factory_reset (bool),
firmware_path (string), firmware_hardware (string).`,
  ConfigPatchSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ values }) => restResult(await apiPatch("fbos_config", values)),
);

server.tool(
  "farmbot_get_web_app_config",
  `Get web app config: image processing thresholds (HSV ranges) for camera calibration
and weed detection, UI preferences, map/garden view options.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("web_app_config")),
);

server.tool(
  "farmbot_patch_web_app_config",
  `Update web app config values. Pass only the keys you want to change in 'values'.

Notable HSV-range keys (for image processing) live in farmware_envs, not here.`,
  ConfigPatchSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ values }) => restResult(await apiPatch("web_app_config", values)),
);

// ── Regimens (watering schedules) ────────────────────────────────

server.tool(
  "farmbot_list_regimens",
  `List all regimens — recurring schedules of sequences (e.g. daily watering, weekly fertilizing).
A regimen is a list of {sequence_id, time_offset} items applied to plants/groups via FarmEvents.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("regimens")),
);

server.tool(
  "farmbot_get_regimen",
  `Get a single regimen by ID, including its regimen_items (the actual schedule).`,
  ResourceByIdSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id }) => restResult(await apiGet(`regimens/${id}`)),
);

server.tool(
  "farmbot_add_regimen",
  `Create a new regimen (recurring schedule).

regimen_items is a list of {sequence_id, time_offset}.
time_offset is milliseconds from midnight of the regimen start day.
Example: 21600000 = 6:00am, 43200000 = 12:00pm.

To make the regimen actually run, schedule a FarmEvent that targets it via
farmbot_add_farm_event with executable_type='Regimen'.`,
  AddRegimenParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ name, color, regimen_items, body }) => {
    return restResult(
      await apiPost("regimens", {
        name,
        color: color ?? "gray",
        regimen_items,
        body: body ?? [],
      }),
    );
  },
);

server.tool(
  "farmbot_update_regimen",
  `Update a regimen's name, color, or schedule. Pass only fields you want to change.`,
  UpdateRegimenParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => {
    return restResult(await apiPatch(`regimens/${id}`, changes));
  },
);

server.tool(
  "farmbot_remove_regimen",
  `Delete a regimen by ID. Removes the schedule but does not delete the underlying sequences.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const result = await apiDelete(`regimens/${id}`);
    if (result.ok) return mcpOk(`Regimen ${id} removed.`);
    return restResult(result);
  },
);

// ── Diagnostic dumps & telemetry ─────────────────────────────────

server.tool(
  "farmbot_list_diagnostic_dumps",
  `List diagnostic dumps generated by the FarmBot for support/troubleshooting.

Note: this endpoint may 404 on some FarmBot deployments — diagnostic dumps are
generated on demand from the web app's "Send to support" flow and may not be
exposed via the public REST API on all servers.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("diagnostic_dumps")),
);

server.tool(
  "farmbot_list_telemetry",
  `List telemetry samples (CPU usage, memory, MQTT round-trip times, etc.) recorded by FBOS.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("telemetries")),
);

// ── Saved gardens & plant templates ──────────────────────────────

server.tool(
  "farmbot_list_saved_gardens",
  `List saved garden layouts. A saved garden is a named snapshot of plant_templates
that can be applied to the active garden.`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("saved_gardens")),
);

server.tool(
  "farmbot_list_plant_templates",
  `List plant_templates — plants stored against saved gardens (not the live garden).`,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async () => restResult(await apiGet("plant_templates")),
);

// ── execute_script (farmware runner — the only setup primitive) ──

server.tool(
  "farmbot_execute_script",
  `Run a farmware (on-device script) by label. This is the sole primitive for
all setup/calibration/detection workflows — there are no separate "calibrate"
or "detect-weeds" tools because they would just hardcode a label here.

Common labels (also discoverable via farmbot_list_farmwares):
- 'camera-calibration' — photograph the printed red-dot card and compute
  coord_scale, image_bot_origin_location, total_rotation_angle. Writes results
  to farmware_envs (read after with farmbot_list_farmware_envs, filter for
  CAMERA_CALIBRATION_*). Takes ~30s.
- 'measure-soil-height' — measure soil z at current position, saves a
  'Soil Height' GenericPointer (visible via farmbot_list_points type=GenericPointer).
- 'plant-detection' — run weed/plant detection on the most-recent photo.
  Detected weeds appear as Weed points (farmbot_list_points type=Weed).
  HSV thresholds live in farmware_envs (WEED_DETECTOR_*).
- 'historical-camera-calibration', 'historical-plant-detection' — re-run on
  past photos (use farmbot_list_images to see what's available).
- 'take-photo' — alternative to farmbot_take_photo.

These run on the device and only ACK when finished. Bump timeout_ms or follow
progress with farmbot_status (busy?) and farmbot_list_logs (toast messages).`,
  ExecuteScriptSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ label, envs }) => {
    return withBot(async (bot) => {
      const envPairs = envs
        ? Object.entries(envs).map(([k, v]) => ({ kind: "pair" as const, args: { label: k, value: v } }))
        : undefined;
      const result = await withTimeout(
        bot.execScript(label, envPairs),
        DEFAULT_TIMEOUT,
        `Run farmware ${label}`,
        { longRunning: true },
      );
      if (!result.ok) return result;
      return { ok: true as const, data: { farmware: label, status: "started" } };
    });
  },
);

// ── Sequences (CRUD) ─────────────────────────────────────────────

server.tool(
  "farmbot_get_sequence",
  `Get a single sequence by ID, including its full CeleryScript body.
Use this before farmbot_update_sequence so you don't blow away existing steps.`,
  ResourceByIdSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id }) => restResult(await apiGet(`sequences/${id}`)),
);

server.tool(
  "farmbot_add_sequence",
  `Create a new sequence (a named, reusable on-device script).

Body is FarmBot's CeleryScript AST. Easiest source of truth: read an existing
sequence with farmbot_get_sequence and adapt its body. For Lua-only sequences
pass body=[{kind:'lua', args:{lua:'<your code>'}}].

After creating, run with farmbot_run_sequence({id}). Schedule recurring runs
with farmbot_add_farm_event or wrap into a regimen via farmbot_add_regimen.`,
  AddSequenceParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ name, color, body, args }) => {
    return restResult(
      await apiPost("sequences", {
        name,
        color: color ?? "gray",
        body,
        args: args ?? { version: 20180209, locals: { kind: "scope_declaration", args: {} } },
      }),
    );
  },
);

server.tool(
  "farmbot_update_sequence",
  `Update a sequence. Pass only the fields you want to change.
Tip: fetch with farmbot_get_sequence first if you want to merge body changes.`,
  UpdateSequenceParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => restResult(await apiPatch(`sequences/${id}`, changes)),
);

server.tool(
  "farmbot_remove_sequence",
  `Delete a sequence by ID. Will fail if FarmEvents or Regimens reference it —
remove those first via farmbot_list_farm_events / farmbot_list_regimens.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const r = await apiDelete(`sequences/${id}`);
    if (r.ok) return mcpOk(`Sequence ${id} removed.`);
    return restResult(r);
  },
);

// ── Point groups (CRUD) ──────────────────────────────────────────

server.tool(
  "farmbot_get_point_group",
  `Get a point group by ID, including its member point IDs.`,
  ResourceByIdSchema.shape,
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id }) => restResult(await apiGet(`point_groups/${id}`)),
);

server.tool(
  "farmbot_add_point_group",
  `Create a point group — a named collection of plant/weed/generic points.
Use as a target in regimens and sequences (e.g. "all tomatoes") instead of
hardcoding plant IDs. Use farmbot_list_points to find member IDs.`,
  AddPointGroupParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ name, point_ids, sort_type, criteria }) => {
    return restResult(
      await apiPost("point_groups", {
        name,
        point_ids,
        sort_type: sort_type ?? "xy_ascending",
        criteria: criteria ?? { day: { op: "<", days_ago: 0 }, string_eq: {}, number_eq: {}, number_lt: {}, number_gt: {} },
      }),
    );
  },
);

server.tool(
  "farmbot_update_point_group",
  `Update a point group. Pass only the fields you want to change.`,
  UpdatePointGroupParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => restResult(await apiPatch(`point_groups/${id}`, changes)),
);

server.tool(
  "farmbot_remove_point_group",
  `Delete a point group by ID. Does not delete the underlying points.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const r = await apiDelete(`point_groups/${id}`);
    if (r.ok) return mcpOk(`Point group ${id} removed.`);
    return restResult(r);
  },
);

// ── Generic point update + farm event update ─────────────────────

server.tool(
  "farmbot_update_point",
  `Update any point (Weed, GenericPointer) — for Plants prefer farmbot_update_plant
which has a richer schema (plant_stage, planted_at).`,
  UpdatePointParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => restResult(await apiPatch(`points/${id}`, changes)),
);

server.tool(
  "farmbot_update_farm_event",
  `Update a scheduled farm event (move it, change repeat behavior, swap target).
Use farmbot_list_farm_events to find the ID.`,
  UpdateFarmEventParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => restResult(await apiPatch(`farm_events/${id}`, changes)),
);

// ── Tools (CRUD) ─────────────────────────────────────────────────

server.tool(
  "farmbot_add_tool",
  `Register a new tool (Watering Nozzle, Seeder, Soil Sensor, Rotary Tool, etc).
After creating, assign it to a slot via farmbot_add_point with pointer_type=ToolSlot
referencing the new tool_id.`,
  AddToolParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ name, flow_rate_ml_per_s }) => {
    return restResult(
      await apiPost("tools", { name, flow_rate_ml_per_s: flow_rate_ml_per_s ?? 0 }),
    );
  },
);

server.tool(
  "farmbot_update_tool",
  `Update a tool's name, flow rate, or seeder tip Z offset. Pass only fields you want to change.
Setting flow_rate_ml_per_s lets the dispense() Lua function compute correct durations.`,
  UpdateToolParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => restResult(await apiPatch(`tools/${id}`, changes)),
);

server.tool(
  "farmbot_remove_tool",
  `Delete a tool. Will fail if a tool slot still references it — clear the slot first.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const r = await apiDelete(`tools/${id}`);
    if (r.ok) return mcpOk(`Tool ${id} removed.`);
    return restResult(r);
  },
);

// ── Peripherals (CRUD) ───────────────────────────────────────────

server.tool(
  "farmbot_add_peripheral",
  `Register a peripheral on a GPIO pin (e.g. solenoid valve on pin 8 = "Water").
Once registered, control via farmbot_write_pin, farmbot_toggle_pin, or by name in Lua (on('Water'), off('Water')).`,
  AddPeripheralParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ pin, label, mode }) => {
    return restResult(await apiPost("peripherals", { pin, label, mode: mode ?? 0 }));
  },
);

server.tool(
  "farmbot_update_peripheral",
  `Update a peripheral's pin, label, or mode.`,
  UpdatePeripheralParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => restResult(await apiPatch(`peripherals/${id}`, changes)),
);

server.tool(
  "farmbot_remove_peripheral",
  `Delete a peripheral. The underlying pin can still be controlled via farmbot_write_pin by number.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const r = await apiDelete(`peripherals/${id}`);
    if (r.ok) return mcpOk(`Peripheral ${id} removed.`);
    return restResult(r);
  },
);

// ── Sensors (CRUD) ───────────────────────────────────────────────

server.tool(
  "farmbot_add_sensor",
  `Register a sensor on a GPIO pin (e.g. soil moisture probe).
Use farmbot_read_pin to read; readings are stored as sensor_readings (see farmbot_list_sensor_readings).`,
  AddSensorParamsSchema.shape,
  { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async ({ pin, label, mode }) => {
    return restResult(await apiPost("sensors", { pin, label, mode: mode ?? 0 }));
  },
);

server.tool(
  "farmbot_update_sensor",
  `Update a sensor's pin, label, or mode.`,
  UpdateSensorParamsSchema.shape,
  { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async ({ id, ...changes }) => restResult(await apiPatch(`sensors/${id}`, changes)),
);

server.tool(
  "farmbot_remove_sensor",
  `Delete a sensor.`,
  ResourceByIdSchema.shape,
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async ({ id }) => {
    const r = await apiDelete(`sensors/${id}`);
    if (r.ok) return mcpOk(`Sensor ${id} removed.`);
    return restResult(r);
  },
);


// ── Resources ───────────────────────────────────────────────────────

server.resource(
  "device-status",
  "farmbot://device/status",
  { description: "Current FarmBot device status: position, firmware, connectivity", mimeType: "application/json" },
  async (uri) => {
    const connResult = await connection.acquire();
    if (!connResult.ok) {
      return { contents: [{ uri: uri.href, text: JSON.stringify({ error: connResult.error.message }) }] };
    }

    await withTimeout(connResult.data.readStatus(), DEFAULT_TIMEOUT, "Read status");
    const ds = await readDeviceState(connResult.data);

    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(ds, null, 2),
      }],
    };
  },
);

server.resource(
  "device-capabilities",
  "farmbot://device/capabilities",
  {
    description:
      "Bot's current capabilities snapshot: device record, firmware/fbos config, tools, peripherals, sensors. One pull instead of 5 list calls — ideal for an agent's first turn.",
    mimeType: "application/json",
  },
  async (uri) => {
    const [device, firmware, fbos, tools, peripherals, sensors] = await Promise.all([
      apiGet("device"),
      apiGet("firmware_config"),
      apiGet("fbos_config"),
      apiGet("tools"),
      apiGet("peripherals"),
      apiGet("sensors"),
    ]);
    const snapshot = {
      device: device.ok ? device.data : { error: device.error.message },
      firmware_config: firmware.ok ? firmware.data : { error: firmware.error.message },
      fbos_config: fbos.ok ? fbos.data : { error: fbos.error.message },
      tools: tools.ok ? tools.data : { error: tools.error.message },
      peripherals: peripherals.ok ? peripherals.data : { error: peripherals.error.message },
      sensors: sensors.ok ? sensors.data : { error: sensors.error.message },
    };
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(snapshot, null, 2) }],
    };
  },
);

server.resource(
  "recent-activity",
  "farmbot://device/recent-activity",
  {
    description:
      "Most recent 50 device logs (info/warn/error/success/busy/fun/debug/assertion). Includes toast messages from running Lua/sequences. Pull this to see what the bot just did or to follow a long-running script.",
    mimeType: "application/json",
  },
  async (uri) => {
    const result = await apiGet("logs?per_page=50");
    return {
      contents: [{
        uri: uri.href,
        text: result.ok ? JSON.stringify(result.data, null, 2) : JSON.stringify({ error: result.error.message }),
      }],
    };
  },
);

server.resource(
  "getting-started",
  "farmbot://help/getting-started",
  {
    description:
      "Onboarding cheatsheet: how to do common things (move, water, photo, calibrate). Read this on first connect to learn the canonical workflow.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const text = `# farmbot-agent — getting started

## On connect

1. Pull \`farmbot://device/capabilities\` once for a snapshot of hardware,
   firmware config, tools, peripherals, sensors. You won't need 5 list calls.
2. Check \`farmbot_status\` for live position + busy/locked state before any
   movement command.

## Common tasks

| Goal | Tool(s) |
|---|---|
| Move | \`farmbot_move\` (absolute or relative=true) |
| Stop everything | \`farmbot_emergency_stop\` then \`farmbot_unlock\` |
| Water a plant | \`farmbot_run_sequence\` with the "Water plant" sequence id |
| Take a photo | \`farmbot_take_photo\` (or photo grid: lua \`photo_grid().each(...)\`) |
| List photos | \`farmbot_list_images\` |
| Add a plant | \`farmbot_add_plant\` |
| Mark plant sprouted | \`farmbot_update_plant({id, plant_stage:'sprouted'})\` |
| Schedule recurring watering | Build a regimen with \`farmbot_add_regimen\`, schedule with \`farmbot_add_farm_event\` |
| Calibrate camera | \`farmbot_execute_script({label:'camera-calibration'})\` |
| Detect weeds | \`farmbot_execute_script({label:'plant-detection'})\` then \`farmbot_list_points({pointer_type:'Weed'})\` |
| Follow a long script | \`farmbot://device/recent-activity\` resource OR \`farmbot_list_logs\` |

## Long-running scripts

\`farmbot_lua\` and \`farmbot_run_sequence\` only ACK when the script finishes.
Bump \`timeout_ms\` (max 600000 = 10min) for slow scripts. On timeout, the bot
keeps running — pull \`farmbot://device/recent-activity\` or call
\`farmbot_status\` to follow progress.

## Discovery

Tools group into: Movement, Calibration, Plants, Points/Weeds, Sequences,
Regimens, Schedules (FarmEvents), Config (firmware/fbos/web_app/farmware_envs),
Media (Images/Logs), Diagnostics. Every tool description names its closest
neighbours.
`;
    return { contents: [{ uri: uri.href, text }] };
  },
);

// ── Start Server ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[farmbot-agent] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[farmbot-agent] Fatal:", err);
  process.exit(1);
});

// Graceful shutdown
async function shutdown() {
  console.error("[farmbot-agent] Shutting down...");
  await connection.release();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
