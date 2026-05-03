import { z } from "zod";

/** Move command parameters — shared by CLI and MCP tool */
export const MoveParamsSchema = z.object({
  x: z.number().describe("X coordinate in mm (0 = home, positive = along bed length)"),
  y: z.number().describe("Y coordinate in mm (0 = home, positive = across bed width)"),
  z: z.number().describe("Z coordinate in mm (0 = top, negative = into soil)"),
  speed: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Speed percentage 1-100 (default: 100)"),
  relative: z
    .boolean()
    .optional()
    .describe("If true, move relative to current position instead of absolute"),
});
export type MoveParams = z.infer<typeof MoveParamsSchema>;

/** Home command parameters */
export const HomeParamsSchema = z.object({
  axis: z
    .enum(["x", "y", "z", "all"])
    .optional()
    .describe("Axis to home (default: all)"),
  speed: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Speed percentage 1-100 (default: 100)"),
});
export type HomeParams = z.infer<typeof HomeParamsSchema>;

/** Lua execution parameters — `timeout_ms` is configurable for long scripts */
export const LuaParamsSchema = z.object({
  code: z.string().describe("Lua code to execute on the FarmBot device"),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe(
      "How long to wait for the bot's RPC ACK in ms (default: 30000, max: 600000). The bot only ACKs after the script finishes — for long scripts (photo grid, watering loops) raise this to e.g. 300000 (5 min). On timeout the script keeps running on-device; check farmbot_status and farmbot_logs.",
    ),
});
export type LuaParams = z.infer<typeof LuaParamsSchema>;

/** Pin write parameters */
export const PinWriteSchema = z.object({
  pin: z.number().describe("Pin number on the Arduino/Farmduino board"),
  value: z.number().describe("Pin value (0 or 1 for digital, 0-255 for analog)"),
  mode: z
    .enum(["digital", "analog"])
    .optional()
    .describe("Pin mode (default: digital)"),
});
export type PinWriteParams = z.infer<typeof PinWriteSchema>;

/** Pin read parameters */
export const PinReadSchema = z.object({
  pin: z.number().describe("Pin number to read"),
  mode: z
    .enum(["digital", "analog"])
    .optional()
    .describe("Pin mode (default: digital)"),
});
export type PinReadParams = z.infer<typeof PinReadSchema>;

/** Pin toggle parameters */
export const PinToggleSchema = z.object({
  pin: z.number().describe("Pin number to toggle"),
});
export type PinToggleParams = z.infer<typeof PinToggleSchema>;

/** Calibrate parameters */
export const CalibrateSchema = z.object({
  axis: z.enum(["x", "y", "z"]).describe("Axis to calibrate"),
});
export type CalibrateParams = z.infer<typeof CalibrateSchema>;

/** Find home parameters */
export const FindHomeSchema = z.object({
  axis: z
    .enum(["x", "y", "z", "all"])
    .optional()
    .describe("Axis to find home on (default: all)"),
  speed: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Speed percentage 1-100 (default: 100)"),
});
export type FindHomeParams = z.infer<typeof FindHomeSchema>;

/** Login parameters */
export const LoginParamsSchema = z.object({
  email: z.string().email().describe("FarmBot account email"),
  password: z.string().min(1).describe("FarmBot account password"),
  server: z
    .string()
    .url()
    .optional()
    .describe("FarmBot server URL (default: https://my.farm.bot)"),
});
export type LoginParams = z.infer<typeof LoginParamsSchema>;

/** Add plant parameters */
export const AddPlantParamsSchema = z.object({
  name: z.string().describe("Plant name (e.g. 'Tomato', 'Basil')"),
  x: z.number().describe("X coordinate in mm"),
  y: z.number().describe("Y coordinate in mm"),
  z: z.number().optional().default(0).describe("Z coordinate in mm (default: 0)"),
  radius: z.number().optional().default(25).describe("Plant radius in mm (default: 25)"),
  openfarm_slug: z.string().optional().describe("OpenFarm crop slug for plant info"),
});
export type AddPlantParams = z.infer<typeof AddPlantParamsSchema>;

/** Update plant parameters */
export const UpdatePlantParamsSchema = z.object({
  id: z.number().describe("Plant ID"),
  name: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  radius: z.number().optional(),
  openfarm_slug: z.string().optional(),
  plant_stage: z
    .enum(["planned", "planted", "sprouted", "harvested", "removed", "active"])
    .optional()
    .describe("Plant lifecycle stage"),
  planted_at: z.string().optional().describe("ISO 8601 timestamp when plant was put in the ground"),
});
export type UpdatePlantParams = z.infer<typeof UpdatePlantParamsSchema>;

/** Remove resource by ID */
export const ResourceByIdSchema = z.object({
  id: z.number().describe("Resource ID"),
});
export type ResourceById = z.infer<typeof ResourceByIdSchema>;

/** Run sequence parameters */
export const RunSequenceParamsSchema = z.object({
  id: z.number().describe("Sequence ID to execute"),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe(
      "How long to wait for the bot's RPC ACK in ms (default: 30000). On timeout the sequence keeps running on-device; use farmbot_status / farmbot_logs to monitor.",
    ),
});
export type RunSequenceParams = z.infer<typeof RunSequenceParamsSchema>;

/** Add farm event parameters */
export const AddFarmEventParamsSchema = z.object({
  sequence_id: z.number().describe("ID of the sequence to run"),
  start_time: z.string().describe("Start time in ISO 8601 format (e.g. '2026-04-01T06:00:00.000Z')"),
  repeat: z
    .enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly", "never"])
    .optional()
    .default("never")
    .describe("Repeat interval (default: never)"),
  end_time: z.string().optional().describe("End time in ISO 8601 format (required if repeat is not 'never')"),
});
export type AddFarmEventParams = z.infer<typeof AddFarmEventParamsSchema>;

// ── Listing/filtering schemas ────────────────────────────────────────

/** List images query parameters */
export const ListImagesParamsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max images to return (default 25, server caps at 100)"),
});
export type ListImagesParams = z.infer<typeof ListImagesParamsSchema>;

/** List logs query parameters */
export const ListLogsParamsSchema = z.object({
  type: z
    .enum(["info", "success", "warn", "error", "busy", "fun", "debug", "assertion"])
    .optional()
    .describe("Filter by log message type"),
  verbosity: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe("Filter by verbosity level 0-3"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max log entries to return (default 50)"),
});
export type ListLogsParams = z.infer<typeof ListLogsParamsSchema>;

/** List points (filter by pointer_type) */
export const ListPointsParamsSchema = z.object({
  pointer_type: z
    .enum(["Plant", "Weed", "GenericPointer", "ToolSlot"])
    .optional()
    .describe("Filter by point type. Omit to list all points."),
});
export type ListPointsParams = z.infer<typeof ListPointsParamsSchema>;

/** Add weed/generic point parameters */
export const AddPointParamsSchema = z.object({
  pointer_type: z.enum(["Weed", "GenericPointer"]).describe("Point type"),
  name: z.string().describe("Point name"),
  x: z.number().describe("X coordinate in mm"),
  y: z.number().describe("Y coordinate in mm"),
  z: z.number().optional().default(0).describe("Z coordinate in mm (default: 0)"),
  radius: z.number().optional().default(25).describe("Point radius in mm (default: 25)"),
  meta: z.record(z.string()).optional().describe("Optional metadata (e.g. {color: 'red'})"),
});
export type AddPointParams = z.infer<typeof AddPointParamsSchema>;

// ── Config schemas ───────────────────────────────────────────────────

/**
 * Generic config patch — accepts any flat key/value record.
 * The FarmBot API accepts partial updates; pass only the fields you want to change.
 */
export const ConfigPatchSchema = z.object({
  values: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .describe("Map of config keys to new values. Only changed keys need to be included."),
});
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

/** Set/upsert a single farmware env var */
export const FarmwareEnvUpsertSchema = z.object({
  key: z.string().describe("Env var name (e.g. 'CAMERA_CALIBRATION_coord_scale')"),
  value: z.string().describe("Env var value (always stored as string)"),
});
export type FarmwareEnvUpsert = z.infer<typeof FarmwareEnvUpsertSchema>;

// ── MQTT execute_script schemas ──────────────────────────────────────

/** Run a farmware/script on the bot */
export const ExecuteScriptSchema = z.object({
  label: z
    .string()
    .describe(
      "Farmware label (e.g. 'camera-calibration', 'measure-soil-height', 'plant-detection', 'historical-camera-calibration', 'historical-plant-detection', 'take-photo')",
    ),
  envs: z
    .record(z.string())
    .optional()
    .describe("Optional env vars passed to the farmware as Pair[]"),
});
export type ExecuteScriptParams = z.infer<typeof ExecuteScriptSchema>;

// ── Regimen schemas ──────────────────────────────────────────────────

/** Single regimen item — runs a sequence at a fixed offset from regimen start */
export const RegimenItemSchema = z.object({
  sequence_id: z.number().describe("Sequence to execute"),
  time_offset: z
    .number()
    .int()
    .describe("Offset from regimen start day, in milliseconds (0 = midnight, 21600000 = 6am)"),
});
export type RegimenItem = z.infer<typeof RegimenItemSchema>;

/** Create a regimen — a recurring schedule attached to plants/groups */
export const AddRegimenParamsSchema = z.object({
  name: z.string().describe("Regimen name (e.g. 'Daily Watering')"),
  color: z
    .enum([
      "blue",
      "green",
      "yellow",
      "orange",
      "purple",
      "pink",
      "gray",
      "red",
    ])
    .optional()
    .default("gray"),
  regimen_items: z.array(RegimenItemSchema).describe("Schedule of sequences to run"),
  body: z
    .array(
      z.object({
        kind: z.literal("parameter_application"),
        args: z.record(z.unknown()),
      }),
    )
    .optional()
    .describe("Optional parameter applications"),
});
export type AddRegimenParams = z.infer<typeof AddRegimenParamsSchema>;

/** Update a regimen */
export const UpdateRegimenParamsSchema = z.object({
  id: z.number().describe("Regimen ID"),
  name: z.string().optional(),
  color: z
    .enum(["blue", "green", "yellow", "orange", "purple", "pink", "gray", "red"])
    .optional(),
  regimen_items: z.array(RegimenItemSchema).optional(),
});
export type UpdateRegimenParams = z.infer<typeof UpdateRegimenParamsSchema>;

// ── Generic point update (weed / generic / plant) ───────────────────

export const UpdatePointParamsSchema = z.object({
  id: z.number().describe("Point ID"),
  name: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  radius: z.number().optional(),
  meta: z.record(z.string()).optional(),
});
export type UpdatePointParams = z.infer<typeof UpdatePointParamsSchema>;

// ── Sequences (CRUD) ─────────────────────────────────────────────────

/**
 * Create a sequence. The body field is FarmBot's CeleryScript AST — easiest
 * source of truth is to read an existing sequence via farmbot_list_sequences
 * and adapt its `body` array.
 */
export const AddSequenceParamsSchema = z.object({
  name: z.string().describe("Sequence name"),
  color: z
    .enum(["blue", "green", "yellow", "orange", "purple", "pink", "gray", "red"])
    .optional()
    .describe("Display color (default: gray)"),
  body: z
    .array(z.record(z.unknown()))
    .describe(
      "CeleryScript body — array of step objects ({kind, args, body?}). For Lua-only sequences use [{kind:'lua', args:{lua:'<code>'}}].",
    ),
  args: z
    .record(z.unknown())
    .optional()
    .describe("Sequence args/locals (parameter declarations). Optional for simple sequences."),
});
export type AddSequenceParams = z.infer<typeof AddSequenceParamsSchema>;

export const UpdateSequenceParamsSchema = z.object({
  id: z.number().describe("Sequence ID"),
  name: z.string().optional(),
  color: z
    .enum(["blue", "green", "yellow", "orange", "purple", "pink", "gray", "red"])
    .optional(),
  body: z.array(z.record(z.unknown())).optional(),
  args: z.record(z.unknown()).optional(),
});
export type UpdateSequenceParams = z.infer<typeof UpdateSequenceParamsSchema>;

// ── Point groups (CRUD) ─────────────────────────────────────────────

export const AddPointGroupParamsSchema = z.object({
  name: z.string().describe("Group name"),
  point_ids: z.array(z.number()).describe("IDs of points in the group"),
  sort_type: z
    .enum(["xy_ascending", "yx_ascending", "xy_descending", "yx_descending", "random", "nn"])
    .optional()
    .describe("Traversal order for sequences targeting this group (default: xy_ascending)"),
  criteria: z
    .record(z.unknown())
    .optional()
    .describe("Optional smart-group criteria (filter expression)"),
});
export type AddPointGroupParams = z.infer<typeof AddPointGroupParamsSchema>;

export const UpdatePointGroupParamsSchema = z.object({
  id: z.number().describe("Point group ID"),
  name: z.string().optional(),
  point_ids: z.array(z.number()).optional(),
  sort_type: z
    .enum(["xy_ascending", "yx_ascending", "xy_descending", "yx_descending", "random", "nn"])
    .optional(),
  criteria: z.record(z.unknown()).optional(),
});
export type UpdatePointGroupParams = z.infer<typeof UpdatePointGroupParamsSchema>;

// ── Farm event update ───────────────────────────────────────────────

export const UpdateFarmEventParamsSchema = z.object({
  id: z.number().describe("Farm event ID"),
  start_time: z.string().optional().describe("ISO 8601"),
  end_time: z.string().optional().describe("ISO 8601"),
  repeat: z.number().int().optional().describe("Repeat count (0 = single fire)"),
  time_unit: z
    .enum(["never", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"])
    .optional(),
  executable_id: z.number().optional(),
  executable_type: z.enum(["Sequence", "Regimen"]).optional(),
});
export type UpdateFarmEventParams = z.infer<typeof UpdateFarmEventParamsSchema>;

// ── Tools / peripherals / sensors (CRUD) ────────────────────────────

export const AddToolParamsSchema = z.object({
  name: z.string().describe("Tool name (e.g. 'Watering Nozzle')"),
  flow_rate_ml_per_s: z
    .number()
    .optional()
    .describe("For watering tools — set so dispense() can compute durations"),
});
export type AddToolParams = z.infer<typeof AddToolParamsSchema>;

export const UpdateToolParamsSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  flow_rate_ml_per_s: z.number().optional(),
  seeder_tip_z_offset: z.number().optional(),
});
export type UpdateToolParams = z.infer<typeof UpdateToolParamsSchema>;

export const AddPeripheralParamsSchema = z.object({
  pin: z.number().int().describe("GPIO pin number"),
  label: z.string().describe("Peripheral name (e.g. 'Water', 'Lighting')"),
  mode: z.number().int().min(0).max(1).optional().describe("0 = digital, 1 = analog (default: 0)"),
});
export type AddPeripheralParams = z.infer<typeof AddPeripheralParamsSchema>;

export const UpdatePeripheralParamsSchema = z.object({
  id: z.number(),
  pin: z.number().int().optional(),
  label: z.string().optional(),
  mode: z.number().int().min(0).max(1).optional(),
});
export type UpdatePeripheralParams = z.infer<typeof UpdatePeripheralParamsSchema>;

export const AddSensorParamsSchema = z.object({
  pin: z.number().int(),
  label: z.string(),
  mode: z.number().int().min(0).max(1).optional(),
});
export type AddSensorParams = z.infer<typeof AddSensorParamsSchema>;

export const UpdateSensorParamsSchema = z.object({
  id: z.number(),
  pin: z.number().int().optional(),
  label: z.string().optional(),
  mode: z.number().int().min(0).max(1).optional(),
});
export type UpdateSensorParams = z.infer<typeof UpdateSensorParamsSchema>;

// ── Output envelope ──────────────────────────────────────────────────

/** JSON output envelope */
export interface OutputEnvelope<T = unknown> {
  ok: boolean;
  command: string;
  data?: T | undefined;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    hint?: string | undefined;
  } | undefined;
}
