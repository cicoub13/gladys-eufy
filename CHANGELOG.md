# Changelog

## [Unreleased]

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
