// Lazy half of the community nudge: arming rules plus the card. Nothing here is
// reachable from the startup graph, so the Control UI pays for it only on the load
// that actually arms the invite.
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { COMMUNITY_INVITE_SETTLED_EVENT } from "../components/community-invite-dialog.ts";
import {
  isCommunityInviteSettled,
  readCommunityInviteRecord,
  writeCommunityInviteRecord,
  type CommunityInviteHost,
  type CommunityInviteOutcome,
  type CommunityInviteRecord,
} from "./community-invite.ts";

/** An upgraded operator never sees the card on the first load of the new build;
 * from the second qualified load the dwell timer decides. */
const ESTABLISHED_MIN_LOADS = 2;
/** A fresh install has to look like a returning user first: onboarding and the
 * first days of evaluation stay free of community chrome. */
const NEW_INSTALL_MIN_LOADS = 3;
const NEW_INSTALL_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
/** Dwell inside one connected load, so the card lands in a working session
 * instead of on a cold page open. */
const DWELL_MS = 5 * 60 * 1000;
/** Re-check cadence while the moment is unsuitable (tab hidden, operator typing). */
const RETRY_MS = 30 * 1000;
const CONTEXT_POLL_MS = 1000;

export function communityInviteReadiness(
  record: CommunityInviteRecord,
  nowMs: number,
): "ready" | "waiting" {
  if (isCommunityInviteSettled(record)) {
    return "waiting";
  }
  if (record.established) {
    return record.qualifiedLoads >= ESTABLISHED_MIN_LOADS ? "ready" : "waiting";
  }
  const oldEnough = nowMs - record.firstQualifiedAtMs >= NEW_INSTALL_MIN_AGE_MS;
  return record.qualifiedLoads >= NEW_INSTALL_MIN_LOADS && oldEnough ? "ready" : "waiting";
}

/** Records this load against the stored history and reports the resulting record. */
export function recordQualifiedLoad(
  previous: CommunityInviteRecord | null,
  hasSessions: boolean,
  nowMs: number,
): CommunityInviteRecord {
  if (!previous) {
    // The very first sighting classifies the operator. Existing sessions mean this
    // browser met an install that was already in use, i.e. an upgrade.
    return { firstQualifiedAtMs: nowMs, qualifiedLoads: 1, established: hasSessions };
  }
  return { ...previous, qualifiedLoads: previous.qualifiedLoads + 1 };
}

/** A modal must never take focus away from something the operator is using. */
function momentIsSuitable(): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus()) {
    return false;
  }
  const active = document.activeElement;
  return !(
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement)
  );
}

export function runCommunityInvite(host: CommunityInviteHost): () => void {
  let disposed = false;
  let qualified = false;
  let presentTimer: ReturnType<typeof setTimeout> | null = null;
  let attachTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeGateway: (() => void) | null = null;
  let unsubscribeSessions: (() => void) | null = null;

  const settle = (outcome: CommunityInviteOutcome) => {
    const record = readCommunityInviteRecord();
    if (!record) {
      return;
    }
    writeCommunityInviteRecord({
      ...record,
      settledAtMs: Date.now(),
      settledVersion: CONTROL_UI_BUILD_INFO.version,
      outcome,
    });
  };

  const present = () => {
    if (disposed || isCommunityInviteSettled(readCommunityInviteRecord())) {
      return;
    }
    if (!momentIsSuitable()) {
      presentTimer = setTimeout(present, RETRY_MS);
      return;
    }
    const card = document.createElement("openclaw-community-invite-dialog");
    card.addEventListener(COMMUNITY_INVITE_SETTLED_EVENT, (event) => {
      settle((event as CustomEvent<{ outcome: CommunityInviteOutcome }>).detail.outcome);
      card.remove();
    });
    document.body.append(card);
    // The card is terminal for this scheduler; nothing re-arms it.
    dispose();
  };

  const evaluate = () => {
    const context = host.context;
    if (disposed || qualified || !context || host.onboardingMode) {
      return;
    }
    if (context.gateway.snapshot.phase !== "connected" || !context.sessions.state.result) {
      return;
    }
    qualified = true;
    const now = Date.now();
    const record = recordQualifiedLoad(
      readCommunityInviteRecord(),
      context.sessions.state.result.sessions.length > 0,
      now,
    );
    writeCommunityInviteRecord(record);
    if (communityInviteReadiness(record, now) === "ready") {
      presentTimer = setTimeout(present, DWELL_MS);
    }
  };

  function dispose() {
    disposed = true;
    if (presentTimer !== null) {
      clearTimeout(presentTimer);
      presentTimer = null;
    }
    if (attachTimer !== null) {
      clearTimeout(attachTimer);
      attachTimer = null;
    }
    unsubscribeGateway?.();
    unsubscribeSessions?.();
    unsubscribeGateway = unsubscribeSessions = null;
  }

  // The shell can hand over a context before or after the gateway connects, so the
  // first evaluation runs eagerly and subscriptions cover every later transition.
  const attach = () => {
    const context = host.context;
    if (!context || unsubscribeGateway) {
      return;
    }
    unsubscribeGateway = context.gateway.subscribe(evaluate);
    unsubscribeSessions = context.sessions.subscribe(evaluate);
  };
  const attachOrRetry = () => {
    attachTimer = null;
    attach();
    evaluate();
    if (!disposed && !unsubscribeGateway) {
      // Context lands with the first shell render; poll rather than reach into the
      // host's update lifecycle from a lazily loaded module.
      attachTimer = setTimeout(attachOrRetry, CONTEXT_POLL_MS);
    }
  };
  attachOrRetry();

  return dispose;
}
