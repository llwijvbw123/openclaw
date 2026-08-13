import {
  onEffectiveOperatorDevicePaired,
  type EffectiveOperatorDeviceIdentity,
} from "../infra/device-pairing.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { shouldRetainControlUiDeviceAuthMigrationSession } from "./server-public.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

export function createControlUiDeviceAuthMigrationLifecycle(params: {
  migration: { pending: boolean };
  completeMigration: typeof import("../state/control-ui-device-auth-migration.js").completeControlUiDeviceAuthMigration;
  clients: Set<GatewayWsClient>;
  log: GatewayLogger;
}): {
  completeForEffectiveOperator: (device: EffectiveOperatorDeviceIdentity) => void;
  unsubscribe: () => void;
} {
  const completeForEffectiveOperator = (device: EffectiveOperatorDeviceIdentity) => {
    if (
      !params.migration.pending ||
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.pairing"],
        allowedScopes: device.scopes,
      })
    ) {
      return;
    }
    const normalizedDeviceId = device.deviceId.trim();
    // Close the process-local grace immediately after approval. The durable
    // receipt prevents stale legacy config from reopening it.
    params.migration.pending = false;
    for (const client of params.clients) {
      if (!client.isControlUiDeviceAuthMigrationSession) {
        continue;
      }
      if (
        client.isControlUiDeviceAuthMigration &&
        shouldRetainControlUiDeviceAuthMigrationSession({
          sessionDevice: client.connect.device,
          approvedDevice: device,
        })
      ) {
        // Retention is bound to the approved key as well as its derived id.
        // Keep only that identity long enough to receive the approval response.
        continue;
      }
      client.invalidated = true;
      client.invalidatedReason = "device-auth-migration-completed";
      client.socket.close(4001, "device auth migration completed");
    }
    try {
      params.completeMigration(normalizedDeviceId, { env: process.env });
    } catch (error) {
      params.log.warn(
        `failed to persist Control UI device-auth migration completion: ${String(error)}`,
      );
    }
  };

  return {
    completeForEffectiveOperator,
    unsubscribe: onEffectiveOperatorDevicePaired(completeForEffectiveOperator),
  };
}
