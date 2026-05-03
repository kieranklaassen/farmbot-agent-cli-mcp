# MCP tools reference

Grouped catalog of all `farmbot_*` MCP tools. Use this to learn the surface area; tool descriptions in `mcp.ts` carry the per-call detail.

## How to use

- Pull `farmbot://device/capabilities` resource on first connect for a hardware/config snapshot.
- Pull `farmbot://device/recent-activity` to see the latest 50 device logs (toast messages from running scripts).
- Pull `farmbot://help/getting-started` for the cheatsheet.

## Tool index

### Status & lifecycle
| Tool | What |
|---|---|
| `farmbot_status` | Live position, busy/locked, firmware. Always check before moves. |
| `farmbot_get_position` | Just x/y/z. Lightweight. |
| `farmbot_get_device_info` | Firmware/controller/uptime/wifi. |
| `farmbot_get_device_config` | REST device record (name, timezone, etc). |
| `farmbot_emergency_stop` | Halt + lock. |
| `farmbot_unlock` | Resume after e-stop. |
| `farmbot_sync` | Sync device with web app (after REST writes). |
| `farmbot_reboot` | Reboot FBOS. |

### Motion
| Tool | What |
|---|---|
| `farmbot_move` | Absolute or relative move. |
| `farmbot_home` | Move to (0,0,0) on all axes or one. |
| `farmbot_find_home` | Endstop/encoder homing — sets origin. |
| `farmbot_calibrate` | Find axis length (writes firmware_config). |

### Plants
| Tool | What |
|---|---|
| `farmbot_list_plants` | List Plant pointers. |
| `farmbot_add_plant` | Create. |
| `farmbot_update_plant` | Patch (incl. plant_stage / planted_at). |
| `farmbot_remove_plant` | Delete by ID. |

### Generic points (weeds, markers, tool slots)
| Tool | What |
|---|---|
| `farmbot_list_points` | Filter by pointer_type (Plant/Weed/GenericPointer/ToolSlot). |
| `farmbot_add_point` | Create Weed or GenericPointer. |
| `farmbot_update_point` | Patch any point. |
| `farmbot_remove_point` | Delete. |

### Point groups (named collections for regimens/sequences)
| Tool | What |
|---|---|
| `farmbot_list_point_groups` | List. |
| `farmbot_get_point_group` | Get by ID with member IDs. |
| `farmbot_add_point_group` | Create. |
| `farmbot_update_point_group` | Patch. |
| `farmbot_remove_point_group` | Delete. |

### Sequences (reusable scripts)
| Tool | What |
|---|---|
| `farmbot_list_sequences` | List names + IDs. |
| `farmbot_get_sequence` | Full CeleryScript body. |
| `farmbot_add_sequence` | Create — body is CeleryScript JSON. |
| `farmbot_update_sequence` | Patch. |
| `farmbot_remove_sequence` | Delete (fails if referenced). |
| `farmbot_run_sequence` | Execute by ID (long-running aware). |

### Regimens (recurring schedules of sequences)
| Tool | What |
|---|---|
| `farmbot_list_regimens` | List. |
| `farmbot_get_regimen` | With regimen_items. |
| `farmbot_add_regimen` | Create with regimen_items. |
| `farmbot_update_regimen` | Patch. |
| `farmbot_remove_regimen` | Delete. |

### Farm events (one-shot or recurring schedules binding sequences/regimens to time)
| Tool | What |
|---|---|
| `farmbot_list_farm_events` | List. |
| `farmbot_add_farm_event` | Create. |
| `farmbot_update_farm_event` | Patch. |
| `farmbot_remove_farm_event` | Delete. |

### Tools / peripherals / sensors (hardware register)
| Tool | What |
|---|---|
| `farmbot_list_tools` | UTM tools. |
| `farmbot_add_tool` / `update` / `remove` | CRUD. |
| `farmbot_list_peripherals` | GPIO peripherals. |
| `farmbot_add_peripheral` / `update` / `remove` | CRUD. |
| `farmbot_list_sensors` | GPIO sensors. |
| `farmbot_add_sensor` / `update` / `remove` | CRUD. |

### Pins
| Tool | What |
|---|---|
| `farmbot_read_pin` | Read GPIO. |
| `farmbot_write_pin` | Write GPIO. |
| `farmbot_toggle_pin` | Flip GPIO. |

### Camera & media
| Tool | What |
|---|---|
| `farmbot_take_photo` | Take a photo. |
| `farmbot_list_images` | List photos with URL + capture coords. |
| `farmbot_get_image` | Get one. |
| `farmbot_remove_image` | Delete one. |

### Logs & telemetry
| Tool | What |
|---|---|
| `farmbot_list_logs` | Toast/info/warn/error logs. |
| `farmbot_list_sensor_readings` | Sensor history. |
| `farmbot_list_telemetry` | CPU/mem/MQTT samples. |
| `farmbot_list_diagnostic_dumps` | Support dumps. |
| `farmbot_list_alerts` | Setup/firmware/notification alerts. |

### Config (singletons, all R/W)
| Tool | What |
|---|---|
| `farmbot_get_firmware_config` / `farmbot_patch_firmware_config` | Motor settings, axis lengths, accelerations. |
| `farmbot_get_fbos_config` / `farmbot_patch_fbos_config` | OS-level config. |
| `farmbot_get_web_app_config` / `farmbot_patch_web_app_config` | Web UI prefs. |

### Farmwares (on-device plugins)
| Tool | What |
|---|---|
| `farmbot_list_farmwares` | Installed farmwares. |
| `farmbot_list_farmware_envs` | Calibration vars (CAMERA_CALIBRATION_*, WEED_DETECTOR_*). |
| `farmbot_set_farmware_env` | Upsert one env var. |
| `farmbot_execute_script` | Run a farmware by label. **The only setup primitive** — use for camera-calibration, measure-soil-height, plant-detection. |

### Curves (water/spread/height profiles)
| Tool | What |
|---|---|
| `farmbot_list_curves` | List. |
| `farmbot_get_curve` | Get one. |

### Saved gardens & plant templates
| Tool | What |
|---|---|
| `farmbot_list_saved_gardens` | Snapshot collections. |
| `farmbot_list_plant_templates` | Plants in saved gardens. |

### Escape hatch
| Tool | What |
|---|---|
| `farmbot_lua` | Run arbitrary Lua on-device. Long-running aware. |

## Typical workflows

**First-time setup**
1. `farmbot_status` → confirm online
2. `farmbot_find_home --axis all` → origin
3. `farmbot_calibrate --axis x/y/z` → axis lengths
4. Move camera over calibration card
5. `farmbot_execute_script({label:'camera-calibration'})` → camera calibration
6. Drive a soil-height grid via `farmbot_run_sequence` (Soil Height Grid)

**Add a new plant + schedule watering**
1. `farmbot_list_plants` (avoid duplicates)
2. `farmbot_add_plant({name, x, y, openfarm_slug})`
3. (Optional) Group plants: `farmbot_add_point_group({name:'Tomatoes', point_ids})`
4. Build a watering regimen: `farmbot_add_regimen({name, regimen_items:[{sequence_id, time_offset}]})`
5. Schedule: `farmbot_add_farm_event({sequence_id: <regimen_id>, executable_type:'Regimen', start_time:'…'})`

**Detect weeds & mow**
1. `farmbot_take_photo` at desired x,y
2. `farmbot_execute_script({label:'plant-detection'})`
3. `farmbot_list_points({pointer_type:'Weed'})`
4. `farmbot_run_sequence` (Mow All Weeds)

**Follow a long-running script**
1. Issue `farmbot_lua({code:'…', timeout_ms: 300000})` or `farmbot_run_sequence({id, timeout_ms: 300000})`
2. If it times out, pull `farmbot://device/recent-activity` resource OR `farmbot_list_logs --type info`
3. `farmbot_status` for `busy` flag.
