// -----------------------------------------------------------------------------
// Entry point of the Gladys eufy Security external integration.
//
// Bridges the eufy cloud (through @mega-yfue/eufy-sdk) and Gladys Assistant:
//   - cameras, doorbells, locks, sensors and HomeBases are published to the
//     Gladys discovery;
//   - eufy events become states, camera thumbnails and scene events;
//   - Gladys commands (lock, guard mode) are sent to eufy.
//
// This file is wiring only: the orchestration lives in `src/handlers.js`.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createHandlers } from './src/handlers.js';
import { createEufyClient } from './src/eufy.js';

const gladys = new GladysIntegration();
const handlers = createHandlers({
  gladys,
  createClient: (config) => createEufyClient(config, logger),
  logger,
});

// No `onPoll`: the devices are published with `should_poll: false`, eufy-sdk
// pushes every change (and polls the eufy cloud on its own).
gladys.onScanRequest(handlers.scan);
gladys.onSetValue(handlers.setValue);
gladys.onGetImage(handlers.getImage);
gladys.onConfigUpdated(handlers.configUpdated);
// States published before the user creates a device, or before an update adds a
// feature to it, are silently dropped by the host API: the device needs them
// published again.
gladys.onDeviceCreated(handlers.deviceCreated);
gladys.onDeviceUpdated(handlers.deviceUpdated);
gladys.on('connected', handlers.gladysConnected);
gladys.handleShutdown(handlers.shutdown);

for (const [key, handler] of Object.entries(handlers.actions)) {
  gladys.onAction(key, handler);
}

// A promise nobody handles means state nobody owns any more: say so in the
// integration logs, then let the Gladys supervisor restart a clean process.
process.on('unhandledRejection', (reason) => {
  logger.error(
    'Unhandled promise rejection, exiting so that Gladys restarts the integration:',
    reason,
  );
  process.exit(1);
});

logger.info('Starting the eufy Security integration...');
// Only a refused token rejects here, and Gladys refuses it while it boots too:
// the SDK keeps reconnecting on its own. Exiting would spend the supervisor's
// restart budget and leave the integration in ERROR after five of them.
gladys.connect().catch((err) => {
  logger.error('Initial connection to Gladys failed, the SDK keeps retrying:', err.message);
});
