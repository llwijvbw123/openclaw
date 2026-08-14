// One-shot Discord community nudge. This module is the persistence owner and the
// only part of the invite that the startup graph pays for: an operator who already
// answered the card is terminal here, so the lazy runtime chunk is never fetched
// again. Every arming rule and the card itself live behind that boundary.

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createIdleImport } from "../lib/idle-import.ts";
import type { SessionCapability } from "../lib/sessions/session-capability.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import type { ApplicationGateway } from "./gateway.ts";

export const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite:v1";

export type CommunityInviteOutcome = "joined" | "dismissed";

export type CommunityInviteRecord = {
  /** First Control UI load that reached a connected, non-onboarding shell. */
  firstQualifiedAtMs: number;
  /** Qualified loads so far. Stands in for "sessions of use" in the arming rules. */
  qualifiedLoads: number;
  /** Sessions already existed when this browser first qualified, so the operator
   * upgraded into this build rather than arriving from a fresh install. */
  established: boolean;
  /** Set once the card was answered. Terminal: the nudge never returns. */
  settledAtMs?: number;
  /** Build the card appeared in; null when the artifact ships without identity. */
  settledVersion?: string | null;
  outcome?: CommunityInviteOutcome;
};

/** Only the two capabilities the arming rules read. Naming the whole
 * ApplicationContext here would drag in its route-id type parameter, which is
 * invariant and has nothing to do with this decision. */
type CommunityInviteContext = {
  readonly gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  readonly sessions: Pick<SessionCapability, "state" | "subscribe">;
};

export type CommunityInviteHost = {
  /** The shell publishes its context on first render, so this is absent early. */
  readonly context?: CommunityInviteContext | null;
  readonly onboardingMode: boolean;
  /** Context handover and onboarding mode both change only through a shell render
   * and neither emits on the gateway or sessions capabilities, so leaving
   * onboarding is invisible to those subscriptions. One subscription to the
   * shell's render loop carries both, which is what lets the scheduler wait for
   * them without holding a timer. */
  readonly subscribeShellUpdate: (listener: () => void) => () => void;
};

/** Timestamps and counters both have to be real, non-negative numbers. */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** localStorage is shared, hand-editable and survives across builds, so a stored
 * value is untrusted input rather than a round-trip of our own write. Trusting it
 * lets `{}` spread into `undefined + 1` and lets `{"settledAtMs": null}` read as
 * settled, which would suppress the nudge on that browser forever. Anything that
 * does not parse is dropped so the sequence simply starts over. */
function parseCommunityInviteRecord(value: unknown): CommunityInviteRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const { firstQualifiedAtMs, qualifiedLoads, established, settledAtMs, outcome } = value;
  if (
    !isNonNegativeNumber(firstQualifiedAtMs) ||
    !isNonNegativeNumber(qualifiedLoads) ||
    !Number.isInteger(qualifiedLoads) ||
    typeof established !== "boolean"
  ) {
    return null;
  }
  const qualified = { firstQualifiedAtMs, qualifiedLoads, established };
  if (settledAtMs === undefined) {
    return qualified;
  }
  // Settled is terminal. A half-written settlement must not be the thing that
  // silences the card, so it either reads back whole or not at all.
  if (!isNonNegativeNumber(settledAtMs) || (outcome !== "joined" && outcome !== "dismissed")) {
    return null;
  }
  const { settledVersion } = value;
  return {
    ...qualified,
    settledAtMs,
    outcome,
    settledVersion: typeof settledVersion === "string" ? settledVersion : null,
  };
}

export function readCommunityInviteRecord(): CommunityInviteRecord | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY);
    return raw ? parseCommunityInviteRecord(JSON.parse(raw)) : null;
  } catch {
    // Unreadable state means the nudge simply starts over; it never blocks the app.
    return null;
  }
}

export function writeCommunityInviteRecord(record: CommunityInviteRecord): void {
  try {
    getSafeLocalStorage()?.setItem(COMMUNITY_INVITE_KEY, JSON.stringify(record));
  } catch {
    // Persistence is best effort, matching the update banner's dismissal contract.
  }
}

export function isCommunityInviteSettled(record: CommunityInviteRecord | null): boolean {
  return record?.settledAtMs !== undefined;
}

/** Installs the invite scheduler and returns its disposer. */
export function startCommunityInvite(host: CommunityInviteHost): () => void {
  if (isCommunityInviteSettled(readCommunityInviteRecord())) {
    return () => undefined;
  }
  let stop: (() => void) | null = null;
  let disposed = false;
  const runtimeImport = createIdleImport(
    () => import("./community-invite.runtime.ts"),
    ({ runCommunityInvite }) => {
      // The chunk can land after the shell disconnected; starting then would leak
      // subscriptions onto a detached host.
      if (!disposed) {
        stop = runCommunityInvite(host);
      }
    },
  );
  runtimeImport.schedule();
  return () => {
    disposed = true;
    runtimeImport.dispose();
    stop?.();
    stop = null;
  };
}
