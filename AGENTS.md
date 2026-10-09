# AGENTS.md — gladys-eufy

Project-specific notes. Generic rules (SDK contract, commands, kit-owned files, runtime) are in
`CLAUDE.md`; the module list is in `README.md` § Project layout. Per-version behaviour changes
are in `CHANGELOG.md`.

## Data flow

- `index.js` → `createHandlers()` (`src/handlers.js`, the hub) → one `createSession()`
  (`src/session.js`) → one `EufyMega` client (`src/eufy.js`) at a time.
- `events.attach(client)` runs BEFORE `login()`: eufy-sdk emits from the first push.
- On login `ok`: `refreshDevices` = `getDevices()` (plain records) → `getDevice(sn)` (the
  capability-driven `Device`) → `buildDevice` → `publishDiscoveredDevices` → states.
- `registry` (sn → `Device`) MUST keep the `Device` objects: eufy-sdk holds them weakly, a dropped
  one stops announcing `propertyChanged`.
- Push, not poll: `should_poll: false`, no `onPoll`. State events re-read the device through the
  capability getters (`mapping.readStates`) and `events.publish` only sends changed values.
- States published before the user creates the device are dropped by Gladys:
  `deviceCreated` → `events.forget(sn)` → republish.

## eufy-sdk quirks (handled in code, keep them)

- `login()` / `submitVerifyCode()` / `solveCaptcha()` resolve a `LoginResult`
  (`ok` / `captcha` / `2fa`), they do not throw for the expected flow. A captcha or a code belongs
  to the login that requested it: never call `login()` again while one is pending.
- Account lockout and captcha storms are the main risk: only `unreachable` and expired sessions
  are retried (60 s, ×2, cap 15 min); `credentials` / `locked` / unknown wait for the user to
  save the form again. `sessionExpired` carries `retryAfterMs`: honour it.
- `arming().mode` answers the WIRE integer (0 away, 1 home, 2 schedule, 3-5 custom, 6 off,
  47 geo, 63 disarmed: `mapping.ARMING_MODES`); `setMode` takes the names.
- `lock().locked` / `lock().battery`: a lock carries its own battery, not the `battery`
  capability.
- `leak` / `smoke` / `co` getters are on GUESSED params (provenance `guessed`): they may stay
  undefined until eufy-sdk confirms them. Nothing is published then.
- `snapshotStored()` is the push thumbnail cached by eufy-sdk; it rejects with a `reason`
  (`pending` while downloading → retried by `events.publishThumbnail`).
- `noBroadcast: true`: the container is on a bridge network, the P2P LAN broadcast cannot work.

## Gladys contract points

- Camera images: `image/jpg;base64,...` ≤ 150 KB (`src/image.js` halves bigger ones),
  12 per minute per device, expire after 1 h. `onGetImage` answers the cached thumbnail.
- Lock command: only `0`/`1`/`"0"`/`"1"` are accepted — `Number('')` is 0 and would unlock.
- Commands are acked under 5 s: eufy calls get 4 s (`commands.COMMAND_TIMEOUT_MS`).
- `onConfigUpdated` is not acknowledged: `applyConfig` never throws, errors go to the status.
- The one-shot answers are emptied with `setConfig`; `usedAnswers` stops a used code from being
  replayed if the form still shows it.

## IDs and config (must stay stable)

- Device `external_id` = `externalIds('eufy', sn)`; feature keys in `mapping.FEATURES`
  (pinned by `test/compat.test.js`).
- Config keys: `email`, `password`, `country`, `verification_code`, `captcha_answer`.
- Scene trigger keys and their `device` / `target` / `phase` fields are forever.
- `/data/eufy-session.json` and `/data/eufy-push.json`: renaming them logs everyone out.
