// Lazy half of the community nudge: the arming rules. Nothing here is reachable
// from the startup graph, and the card itself is a further dynamic import so only
// the load that actually presents pays for the dialog and its art.
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
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
/** Dwell is *accumulated* foreground time inside one load, not continuous
 * presence. Operators tab away constantly while a run streams, so a continuous
 * rule would hide the card from exactly the people using OpenClaw most; the
 * accumulator still proves five real minutes in the app before anything appears. */
const DWELL_MS = 5 * 60 * 1000;
/** Context lands with the first shell render. Bounded so a shell that never
 * publishes one cannot leave a timer chain alive. */
const CONTEXT_POLL_MS = 1000;
const CONTEXT_POLL_ATTEMPTS = 30;

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

/** Foreground presence: the only state in which dwell time accrues. */
export function operatorIsPresent(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** A modal must never take focus away from something the operator is typing into. */
export function editableElementFocused(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement)
  );
}

export function runCommunityInvite(host: CommunityInviteHost): () => void {
  let disposed = false;
  let qualified = false;
  let presented = false;
  let dwellAccumulatedMs = 0;
  let dwellStartedAtMs: number | null = null;
  let dwellSatisfied = false;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let contextTimer: ReturnType<typeof setTimeout> | null = null;
  let contextAttempts = 0;
  let listening = false;
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

  const clearDwellTimer = () => {
    if (dwellTimer !== null) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
  };

  /** Folds the open presence span into the accumulator. */
  const bankDwell = () => {
    if (dwellStartedAtMs !== null) {
      dwellAccumulatedMs += Date.now() - dwellStartedAtMs;
      dwellStartedAtMs = null;
    }
  };

  const tryPresent = () => {
    if (disposed || presented || !dwellSatisfied) {
      return;
    }
    if (!operatorIsPresent() || editableElementFocused()) {
      // No retry timer: the next visibility/focus event brings us back here.
      return;
    }
    // The card is terminal for this scheduler; stop watching before the chunk
    // lands so a late gateway event cannot arm a second one.
    presented = true;
    stopWatching();
    void import("../components/community-invite-dialog.ts")
      .then(({ COMMUNITY_INVITE_SETTLED_EVENT }) => {
        if (disposed) {
          return;
        }
        const card = document.createElement("openclaw-community-invite-dialog");
        card.addEventListener(COMMUNITY_INVITE_SETTLED_EVENT, (event) => {
          settle((event as CustomEvent<{ outcome: CommunityInviteOutcome }>).detail.outcome);
          card.remove();
        });
        document.body.append(card);
      })
      .catch(() => {
        // A failed chunk fetch leaves the record unsettled, so a later load retries.
        presented = false;
      });
  };

  /** One-shot timer for the dwell remainder, alive only while the operator is here. */
  const armDwell = () => {
    if (dwellSatisfied || dwellStartedAtMs !== null || !operatorIsPresent()) {
      return;
    }
    dwellStartedAtMs = Date.now();
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      bankDwell();
      dwellSatisfied = true;
      tryPresent();
    }, DWELL_MS - dwellAccumulatedMs);
  };

  /** Single handler for visibilitychange, window focus/blur and focusin/focusout:
   * presence drives the dwell accumulator, and every event is a chance to present
   * once dwell is satisfied. Nothing polls. */
  const onEnvironmentChange = () => {
    if (disposed || presented) {
      return;
    }
    if (operatorIsPresent()) {
      armDwell();
    } else if (dwellStartedAtMs !== null) {
      clearDwellTimer();
      bankDwell();
    }
    tryPresent();
  };

  const startListening = () => {
    if (listening) {
      return;
    }
    listening = true;
    document.addEventListener("visibilitychange", onEnvironmentChange);
    document.addEventListener("focusin", onEnvironmentChange);
    document.addEventListener("focusout", onEnvironmentChange);
    window.addEventListener("focus", onEnvironmentChange);
    window.addEventListener("blur", onEnvironmentChange);
  };

  const stopListening = () => {
    if (!listening) {
      return;
    }
    listening = false;
    document.removeEventListener("visibilitychange", onEnvironmentChange);
    document.removeEventListener("focusin", onEnvironmentChange);
    document.removeEventListener("focusout", onEnvironmentChange);
    window.removeEventListener("focus", onEnvironmentChange);
    window.removeEventListener("blur", onEnvironmentChange);
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
      startListening();
      armDwell();
    }
  };

  function stopWatching() {
    clearDwellTimer();
    if (contextTimer !== null) {
      clearTimeout(contextTimer);
      contextTimer = null;
    }
    stopListening();
    unsubscribeGateway?.();
    unsubscribeSessions?.();
    unsubscribeGateway = unsubscribeSessions = null;
  }

  function dispose() {
    disposed = true;
    stopWatching();
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
    contextTimer = null;
    attach();
    evaluate();
    if (!disposed && !unsubscribeGateway && (contextAttempts += 1) < CONTEXT_POLL_ATTEMPTS) {
      contextTimer = setTimeout(attachOrRetry, CONTEXT_POLL_MS);
    }
  };
  attachOrRetry();

  return dispose;
}
