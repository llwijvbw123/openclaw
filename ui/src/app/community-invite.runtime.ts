// Lazy half of the community nudge: the arming rules. Nothing here is reachable
// from the startup graph, and the card itself is a further dynamic import so only
// the load that actually presents pays for the dialog and its art.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  COMMUNITY_INVITE_KEY,
  readCommunityInviteOutcome,
  readNonNegativeNumber,
  type CommunityInviteHost,
  type CommunityInviteOutcome,
  type CommunityInviteRecord,
} from "./community-invite.ts";

/** localStorage is shared, hand-editable and outlives the build that wrote it, so
 * a stored value is untrusted input rather than a round-trip of our own write.
 * Trusting it lets `{}` spread into `undefined + 1` qualified loads. Anything that
 * does not parse is dropped, so the sequence simply starts over. */
function parseCommunityInviteRecord(value: unknown): CommunityInviteRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const { firstQualifiedAtMs, qualifiedLoads, established, settledAtMs, outcome } = value;
  const firstSighting = readNonNegativeNumber(firstQualifiedAtMs);
  const loads = readNonNegativeNumber(qualifiedLoads);
  if (firstSighting === null || loads === null || !Number.isInteger(loads)) {
    return null;
  }
  if (typeof established !== "boolean") {
    return null;
  }
  const qualified = { firstQualifiedAtMs: firstSighting, qualifiedLoads: loads, established };
  if (settledAtMs === undefined) {
    return qualified;
  }
  // Settled is terminal, so a half-written settlement must not be what silences
  // the card: it either reads back whole or the record is dropped entirely.
  const settled = readNonNegativeNumber(settledAtMs);
  const answered = readCommunityInviteOutcome(outcome);
  if (settled === null || answered === null) {
    return null;
  }
  const { settledVersion } = value;
  return {
    ...qualified,
    settledAtMs: settled,
    outcome: answered,
    settledVersion: typeof settledVersion === "string" ? settledVersion : null,
  };
}

export function readCommunityInviteRecord(): CommunityInviteRecord | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY);
    return raw ? parseCommunityInviteRecord(JSON.parse(raw)) : null;
  } catch {
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
/** The card is once per browser, not once per tab. Every tab that reaches
 * presentation asks for this lock and only the holder mounts; the rest stand down
 * and learn the outcome from the storage listener below. A tab that closes without
 * answering releases it, so the next qualified tab can take its turn. */
const PRESENTATION_LOCK = "openclaw:control-ui:community-invite";

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

/** The card must never appear over something the operator is typing into.
 * `document.activeElement` stops at a shadow host, and the surfaces that matter
 * most here keep their field inside one — the terminal panel holds a ghostty
 * textarea in its shadow root, so a document-level check sees only
 * `openclaw-terminal-panel` and reads as "nobody is typing". Walk down to the
 * innermost active element before judging. */
export function editableElementFocused(): boolean {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active.getAttribute("role") === "textbox")
  );
}

/** Resolves to a release function when this tab owns the presentation, or to null
 * when another tab already holds it. Where Web Locks are missing the shared record
 * is the remaining guard: presentation still re-reads it, and a settlement in
 * either tab still retires the other card through the storage listener. */
function claimPresentation(): Promise<(() => void) | null> {
  if (!("locks" in navigator)) {
    return Promise.resolve(() => undefined);
  }
  return new Promise((resolve) => {
    void navigator.locks
      .request(PRESENTATION_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return Promise.resolve();
        }
        // Holding this promise open holds the lock; handing its resolver out makes
        // releasing the lock the scheduler's job once the card goes away.
        return new Promise<void>((release) => {
          resolve(() => release());
        });
      })
      .catch(() => resolve(null));
  });
}

export function runCommunityInvite(host: CommunityInviteHost): () => void {
  let disposed = false;
  let qualified = false;
  let presented = false;
  let dwellAccumulatedMs = 0;
  let dwellStartedAtMs: number | null = null;
  let dwellSatisfied = false;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let listening = false;
  let mountedCard: HTMLElement | null = null;
  let releaseClaim: (() => void) | null = null;
  let unsubscribeShellUpdate: (() => void) | null = null;
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

  /** Drops the card and the cross-tab claim together: a claim outliving its card
   * would lock every other tab out for the rest of this tab's life. */
  const removeCard = () => {
    mountedCard?.remove();
    mountedCard = null;
    releaseClaim?.();
    releaseClaim = null;
  };

  const presentCard = async () => {
    const release = await claimPresentation();
    if (!release) {
      // Another tab owns the card. Its outcome reaches this one through storage.
      return;
    }
    releaseClaim = release;
    try {
      const { COMMUNITY_INVITE_SETTLED_EVENT } =
        await import("../components/community-invite-dialog.ts");
      // Both awaits are points where the shell can go away or another tab can
      // answer, so the disposer and the shared record are rechecked before mounting.
      if (disposed || isCommunityInviteSettled(readCommunityInviteRecord())) {
        removeCard();
        return;
      }
      const card = document.createElement("openclaw-community-invite-dialog");
      card.addEventListener(COMMUNITY_INVITE_SETTLED_EVENT, (event) => {
        settle((event as CustomEvent<{ outcome: CommunityInviteOutcome }>).detail.outcome);
        removeCard();
      });
      mountedCard = card;
      document.body.append(card);
    } catch {
      // A failed chunk fetch leaves the record unsettled, so a later load retries.
      presented = false;
      removeCard();
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
    // Another tab may have answered the card while this one was waiting for a
    // suitable moment. The record is the shared truth, so it decides, not the
    // local state this scheduler qualified with.
    if (isCommunityInviteSettled(readCommunityInviteRecord())) {
      dispose();
      return;
    }
    // The card is terminal for this scheduler; stop watching before the chunk
    // lands so a late gateway event cannot arm a second one.
    presented = true;
    stopWatching();
    void presentCard();
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

  /** Another tab answering the card is the only foreign write to this key, and it
   * ends this scheduler too: an already-answered nudge must not stay on screen in
   * a second window. */
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === COMMUNITY_INVITE_KEY &&
      isCommunityInviteSettled(readCommunityInviteRecord())
    ) {
      dispose();
    }
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
    // Qualification is one-shot per load, so the inputs that decide it stop being
    // watched here; only presence still matters from now on.
    stopEligibilityWatch();
    if (communityInviteReadiness(record, now) === "ready") {
      startListening();
      armDwell();
    }
  };

  function stopEligibilityWatch() {
    unsubscribeShellUpdate?.();
    unsubscribeGateway?.();
    unsubscribeSessions?.();
    unsubscribeShellUpdate = unsubscribeGateway = unsubscribeSessions = null;
  }

  function stopWatching() {
    clearDwellTimer();
    stopListening();
    stopEligibilityWatch();
  }

  function dispose() {
    disposed = true;
    window.removeEventListener("storage", onStorage);
    stopWatching();
    removeCard();
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

  window.addEventListener("storage", onStorage);
  // Context arrival and leaving onboarding are both shell renders and nothing else,
  // so this subscription is what makes them observable — and what replaces polling
  // the shell for a context it had not published yet.
  unsubscribeShellUpdate = host.subscribeShellUpdate(() => {
    attach();
    evaluate();
  });
  attach();
  evaluate();

  return dispose;
}
