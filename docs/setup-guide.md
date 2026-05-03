# FarmBot setup & calibration guide

End-to-end walkthrough using `farmbot-agent` (CLI + MCP). Pairs every step with the CLI command and the equivalent MCP tool so an agent can drive the bot from scratch.

---

## 0. Prerequisites

- A FarmBot (Genesis or Express), powered on, on Wi-Fi, paired to the FarmBot web app
- `FARMBOT_TOKEN` in env, **or** run `farmbot login --email ... --password ...` once
- For MCP: this project's `dist/mcp.js` registered as an MCP server

Verify:

```bash
farmbot status              # MCP: farmbot_status
farmbot device-info         # MCP: farmbot_get_device_info
```

You should see firmware/controller versions and `busy: false, locked: false`.

---

## 1. Axis calibration (motor + range)

Calibration knobs live in `firmware_config`. Inspect first:

```bash
farmbot firmware-config-get | jq
```

Notable keys:
| Key | Meaning |
|---|---|
| `movement_axis_nr_steps_x/y/z` | Axis length in motor steps (0 = unknown) |
| `movement_max_spd_x/y/z` | Max travel speed (steps/s) |
| `movement_min_spd_x/y/z` | Starting speed |
| `movement_steps_acc_dec_x/y/z` | Acceleration ramp |
| `movement_home_spd_x/y/z` | Speed used for homing |
| `movement_invert_motor_x/y/z` | Flip motor direction |
| `encoder_enabled_x/y/z` | Use encoders for stall detection |

### 1a. Find home (sets origin)

```bash
farmbot find-home --axis all          # MCP: farmbot_find_home
```

### 1b. Calibrate axis lengths

```bash
farmbot calibrate --axis x            # MCP: farmbot_calibrate
farmbot calibrate --axis y
farmbot calibrate --axis z
```

This drives each axis to its endstop and writes the length back to `movement_axis_nr_steps_*`.

### 1c. Tune motor speeds (optional)

```bash
farmbot firmware-config-patch --values '{"movement_max_spd_x": 800, "movement_max_spd_y": 800}'
farmbot sync                          # apply on-device
```

---

## 2. Camera calibration

The camera is calibrated against the printed red-dot card. Calibration values land in `farmware_envs` (read-only from the agent's POV).

### 2a. Mount the camera and place the calibration card under it

Move the gantry over the card:

```bash
farmbot move --x 100 --y 100 --z 0
```

### 2b. Run calibration

```bash
farmbot calibrate-camera              # MCP: farmbot_calibrate_camera
```

This is a wrapper over `execute-script camera-calibration` — takes ~30s and writes:

| Env var | What it stores |
|---|---|
| `CAMERA_CALIBRATION_coord_scale` | mm per pixel |
| `CAMERA_CALIBRATION_camera_z` | Z height during calibration |
| `CAMERA_CALIBRATION_image_bot_origin_location` | Which image corner is bot (0,0) |
| `CAMERA_CALIBRATION_total_rotation_angle` | Camera rotation vs bot axes |
| `CAMERA_CALIBRATION_calibration_along_axis` | x or y |

Inspect after:

```bash
farmbot farmware-envs | jq '.[] | select(.key | startswith("CAMERA_CALIBRATION"))'
```

### 2c. Manually override a calibration value (rare)

```bash
farmbot farmware-env-set --key CAMERA_CALIBRATION_coord_scale --value 0.95
```

---

## 3. Soil height map

Take measurements across the bed so plants get accurate Z values when watering / weeding.

### 3a. Single measurement at current position

```bash
farmbot move --x 500 --y 500 --z 0
farmbot measure-soil-height           # MCP: farmbot_measure_soil_height
```

Saves a `GenericPointer` named "Soil Height" with the measured z.

### 3b. Full grid

Run the built-in **Soil Height Grid** sequence:

```bash
farmbot sequences | jq '.[] | select(.name=="Soil Height Grid") | .id'
farmbot sequence-run <id>             # MCP: farmbot_run_sequence
```

This walks `photo_grid()` and runs `measure_soil_height()` at each cell. Several minutes — bump CLI `--timeout` or MCP `timeout_ms`.

---

## 4. Weed detection setup

### 4a. Tune HSV thresholds

Weed detector lives in farmware_envs as `WEED_DETECTOR_*`. Tune via:

```bash
farmbot farmware-envs | jq '.[] | select(.key | startswith("WEED_DETECTOR"))'
farmbot farmware-env-set --key WEED_DETECTOR_H_HI --value 90
```

Common keys: `H_LO`, `H_HI`, `S_LO`, `S_HI`, `V_LO`, `V_HI`, `blur`, `morph`, `iteration`, `save_detected_plants`.

### 4b. Test detection

```bash
farmbot photo                          # take a photo first
farmbot detect-weeds                   # MCP: farmbot_detect_weeds
farmbot points --type Weed             # see what was detected
```

### 4c. Weed detection over the whole bed

Run the built-in **Weed Detection Grid** sequence (same shape as the photo/soil grids).

---

## 5. Watering schedules (regimens)

A **regimen** is a recurring schedule of sequences. A **FarmEvent** binds a regimen to a start time + plant target.

### 5a. Inspect what exists

```bash
farmbot regimens
farmbot events
```

### 5b. Create a daily-watering regimen

```bash
# Find the watering sequence first
WATER_SEQ_ID=$(farmbot sequences | jq '.[] | select(.name=="Water plant") | .id')

farmbot regimen-add \
  --name "Daily watering" \
  --color blue \
  --items "[{\"sequence_id\": $WATER_SEQ_ID, \"time_offset\": 21600000}]"
# 21600000 = 6:00am from regimen start day
```

### 5c. Schedule the regimen against plants

`farm_events` with `executable_type='Regimen'` is how you bind it. The agent currently exposes FarmEvent CRUD via:

```bash
farmbot event-add --sequence-id <id> --start <ISO8601> --repeat daily
# (regimen-typed FarmEvents need raw API; use lua or extend cli)
```

### 5d. Update or delete

```bash
farmbot regimen-update <id> --changes '{"color":"green"}'
farmbot regimen-remove <id>
```

---

## 6. Watching long-running operations

`farmbot lua` and `farmbot sequence-run` only ACK when the script finishes. For long scripts (photo grids, watering loops, calibration), the MCP/CLI will return a `DEVICE_TIMEOUT` after `timeout_ms` (default 30000) — but the bot keeps running.

When you see that error: it's not a failure. Use:

```bash
farmbot status                         # MCP: farmbot_status — busy + position
farmbot logs --type info --limit 50    # MCP: farmbot_list_logs — toast() messages
```

To wait longer up-front:

```bash
farmbot --timeout 300000 lua 'photo_grid().each(function(c) move{x=c.x,y=c.y,z=c.z}; take_photo() end)'
```

```jsonc
// MCP
{ "name": "farmbot_lua", "arguments": { "code": "...", "timeout_ms": 300000 } }
```

---

## 7. Useful read endpoints (for the brain)

| What | CLI | MCP tool |
|---|---|---|
| Photos | `farmbot images --limit 50` | `farmbot_list_images` |
| Logs | `farmbot logs --type error` | `farmbot_list_logs` |
| Sensor history | `farmbot sensor-readings` | `farmbot_list_sensor_readings` |
| Active alerts | `farmbot alerts` | `farmbot_list_alerts` |
| Curves | `farmbot curves` | `farmbot_list_curves` |
| Saved gardens | `farmbot saved-gardens` | `farmbot_list_saved_gardens` |
| Telemetry | `farmbot telemetry` | `farmbot_list_telemetry` |
| Diagnostic dumps | `farmbot diagnostic-dumps` | `farmbot_list_diagnostic_dumps` |

---

## 8. Recovery

| Situation | Action |
|---|---|
| Collision / weird motion | `farmbot e-stop` then physically clear, then `farmbot unlock` |
| Stuck script | `farmbot e-stop` (cancels the running RPC), then `unlock` |
| Lost connection | `farmbot status` to reconnect lazy-style; or `farmbot reboot` |
| Bad config | `farmbot firmware-config-patch --values '{...}' && farmbot sync` |
