// One-shot Discord community nudge. This module is the persistence owner and the
// only part of the invite that the startup graph pays for: an operator who already
// answered the card is terminal here, so the lazy runtime chunk is never fetched
// again. Every arming rule and the card itself live behind that boundary.
import { createIdleImport } from "../lib/idle-import.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import type { ApplicationContext } from "./context.ts";

const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite:v1";

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
  settledVersion?: string;
  outcome?: CommunityInviteOutcome;
};

export type CommunityInviteHost = {
  readonly context: ApplicationContext | null;
  readonly onboardingMode: boolean;
};

export function readCommunityInviteRecord(): CommunityInviteRecord | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY);
    return raw ? (JSON.parse(raw) as CommunityInviteRecord) : null;
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
