# Changelog

## [Unreleased]

### Changed

- eufy-sdk 0.5.0: commands now reach the devices behind a HomeBase S1 Pro
  (T9000) and the T8N00 PoE station, more models are recognised (T8213,
  T8210C, T8354, T90S0 smoke alarm...), and the realtime events are retried
  when they fail to start.

## [1.1.2] - 2026-10-28

### Changed

- Maintenance release: dependency and build updates, no functional change.

## [1.1.1] - 2026-10-13

### Fixed

- After updating a device from the discovery, a feature the update added (battery
  charging...) shows its value right away instead of staying empty until the
  value changes.

## [1.1.0] - 2026-10-10

### Fixed

- Contact sensors showed a closed door as open, and an open one as closed.

## [1.0.1] - 2026-10-10

### Added

- **First version.** eufy Security cameras, doorbells, smart locks, sensors and
  HomeBase guard mode in Gladys, through the eufy cloud:
  - camera thumbnails published on every detection and doorbell press;
  - doorbell, motion, contact, leak, smoke, CO, siren and battery features;
  - lock / unlock and guard mode control (unlocking and disarming only once
    allowed in the configuration);
  - scene triggers: doorbell pressed, motion detected (person, stranger,
    vehicle, pet), package delivered, alarm triggered;
  - sign-in with a verification code or a captcha straight from the
    configuration form.
