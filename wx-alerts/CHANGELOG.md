# Changelog

## 1.1.1
- MQTT discovery: use `default_entity_id` (current HA ignores `object_id`) so the sensors are really `sensor.wx_spc_day1_*`; device "SPC day 1 outlook" so friendly names read "SPC day 1 outlook Home".

## 1.1.0
- SPC day 1 categorical outlook as a sensor per target (`sensor.wx_spc_day1_home`, `sensor.wx_spc_day1_<person>`): state 0 none … 6 high risk, label/validity/forecaster as attributes, `wx_spc` event on change. MQTT discovery (persistent) or states API. Shown on the Status tab for every target; settings on the People tab.

## 1.0.1
- Per-level wording: the expand row now actually opens (CSS bug), shows the text each level will use, where it inherits from, and offers "use inherited" / "shipped wording". Wording tab lists every level with its own text and can reset all to the shipped wording.

## 1.0.0
- First add-on release (moved from the workstation service).
