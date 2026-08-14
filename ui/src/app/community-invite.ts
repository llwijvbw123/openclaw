// One-shot Discord community nudge. This module is the only part of the invite the
// startup graph pays for, so it holds one decision and nothing else: an operator
// who already answered the card is terminal here and the lazy runtime chunk is
// never fetched again. Reading, validating and writing the record belongs to that
// chunk, along with every arming rule and the card itself.

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

/** Timestamps and counters both have to be real, non-negative numbers. Shared with
 * the runtime chunk's record parser so the startup probe below and the full parse
 * cannot drift on what a valid record looks like. */
export function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readCommunityInviteOutcome(value: unknown): CommunityInviteOutcome | null {
  return value === "joined" || value === "dismissed" ? value : null;
}

/** The only question the startup graph asks, so it stays cheap: has this browser
 * already answered the card? A settlement counts only when it is whole — a null or
 * hand-edited `settledAtMs` must never be the thing that suppresses the invite on
 * that browser forever. Reading and validating the rest of the record belongs to
 * the runtime chunk, which is the only thing that acts on it. */
export function communityInviteWasAnswered(): boolean {
  try {
    const raw = getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY);
    if (!raw) {
      return false;
    }
    const record = JSON.parse(raw) as Record<string, unknown>;
    return (
      readNonNegativeNumber(record.settledAtMs) !== null &&
      readCommunityInviteOutcome(record.outcome) !== null
    );
  } catch {
    // Unreadable state means the nudge simply starts over; it never blocks the app.
    return false;
  }
}

/** Installs the invite scheduler and returns its disposer. */
export function startCommunityInvite(host: CommunityInviteHost): () => void {
  if (communityInviteWasAnswered()) {
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
