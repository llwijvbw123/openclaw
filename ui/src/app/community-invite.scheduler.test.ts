/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The card is a separate lazy chunk; stubbing it keeps this test on the scheduler's
// event handling instead of the dialog's shadow-DOM dependencies.
vi.mock("../components/community-invite-dialog.ts", () => ({
  COMMUNITY_INVITE_SETTLED_EVENT: "community-invite-settled",
}));

import { runCommunityInvite } from "./community-invite.runtime.ts";
import type { CommunityInviteHost, CommunityInviteRecord } from "./community-invite.ts";

const STORAGE_KEY = "openclaw:control-ui:community-invite:v1";
const DWELL_MS = 5 * 60 * 1000;
const CARD_TAG = "openclaw-community-invite-dialog";

const stops: Array<() => void> = [];
let visibility: DocumentVisibilityState = "visible";
let focused = true;

function seedRecord(record: Partial<CommunityInviteRecord> = {}): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      // An upgraded operator on their second qualified load: the next qualified
      // load makes this record "ready", so only dwell and presence remain.
      firstQualifiedAtMs: Date.now() - 60 * 60 * 1000,
      qualifiedLoads: 1,
      established: true,
      ...record,
    } satisfies CommunityInviteRecord),
  );
}

function readStored(): CommunityInviteRecord {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as CommunityInviteRecord;
}

/** A shell stub that can hand over a new route the way the real one does: by
 * re-rendering. Gateway and sessions stay silent, which is the point. */
function createHost(options: { sessionCount?: number; onboarding?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const raw = {
    context: {
      gateway: { snapshot: { phase: "connected" }, subscribe: () => () => undefined },
      sessions: {
        state: {
          result: { sessions: Array.from({ length: options.sessionCount ?? 2 }, () => ({})) },
        },
        subscribe: () => () => undefined,
      },
    },
    onboardingMode: options.onboarding ?? false,
    subscribeShellUpdate(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    host: raw as unknown as CommunityInviteHost,
    leaveOnboarding() {
      raw.onboardingMode = false;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function start(host: CommunityInviteHost): () => void {
  const dispose = runCommunityInvite(host);
  stops.push(dispose);
  return dispose;
}

/** jsdom ships no Web Locks. This is the slice of the contract the scheduler
 * depends on: with `ifAvailable`, a second request while a holder is active is
 * handed null instead of queueing. */
function installWebLocks(): void {
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request(name: string, _options: unknown, callback: (lock: unknown) => unknown) {
        if (held.has(name)) {
          return Promise.resolve(callback(null));
        }
        held.add(name);
        return Promise.resolve(callback({ name })).finally(() => held.delete(name));
      },
    },
  });
}

/** Pretends the browser retargets `activeElement` to a shadow host, which is what
 * hides a focused field from a document-level check. jsdom's own focus handling
 * does not model the retarget, so the state is declared rather than performed. */
function focusInsideShadowRoot(): void {
  const panel = document.createElement("div");
  const shadow = panel.attachShadow({ mode: "open" });
  const field = document.createElement("textarea");
  shadow.append(field);
  document.body.append(panel);
  Object.defineProperty(shadow, "activeElement", { configurable: true, get: () => field });
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => panel });
}

function blurEverything(): void {
  Reflect.deleteProperty(document, "activeElement");
  document.dispatchEvent(new Event("focusout"));
}

function setPresence(next: { visible?: boolean; focused?: boolean }): void {
  if (next.visible !== undefined) {
    visibility = next.visible ? "visible" : "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  }
  if (next.focused !== undefined) {
    focused = next.focused;
    window.dispatchEvent(new Event(next.focused ? "focus" : "blur"));
  }
}

function mountedCards(): number {
  return document.querySelectorAll(CARD_TAG).length;
}

function cardMounted(): boolean {
  return mountedCards() > 0;
}

/** Presentation crosses the cross-tab claim and then the chunk import, so it
 * settles a few promise hops after the dwell timer fires. */
async function flushImport(): Promise<void> {
  for (let hop = 0; hop < 3; hop += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  visibility = "visible";
  focused = true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.useFakeTimers();
});

afterEach(() => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  // Own-property stubs outlive vi.restoreAllMocks, and a leaked activeElement or
  // lock manager would silently decide the next test.
  Reflect.deleteProperty(document, "activeElement");
  Reflect.deleteProperty(navigator, "locks");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("community invite scheduler", () => {
  it("presents once the dwell elapses with the operator present", async () => {
    seedRecord();
    start(createHost().host);
    expect(cardMounted()).toBe(false);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("does not accrue dwell while the tab is hidden, and keeps no timer alive", async () => {
    seedRecord();
    start(createHost().host);
    setPresence({ visible: false });

    await vi.advanceTimersByTimeAsync(DWELL_MS * 3);
    await flushImport();
    expect(cardMounted()).toBe(false);
    // The invariant behind the event-driven rewrite: an idle, hidden tab runs no
    // periodic work at all.
    expect(vi.getTimerCount()).toBe(0);

    setPresence({ visible: true });
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("accumulates dwell across absences instead of demanding continuous presence", async () => {
    seedRecord();
    start(createHost().host);

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    setPresence({ visible: false });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(cardMounted()).toBe(false);

    setPresence({ visible: true });
    // Only the remaining two minutes are owed, not a fresh five.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("waits for focus to leave an editable field before presenting", async () => {
    seedRecord();
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    start(createHost().host);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    composer.blur();
    document.dispatchEvent(new Event("focusout"));
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("waits for a field inside a shadow root too, where activeElement is the host", async () => {
    seedRecord();
    focusInsideShadowRoot();
    start(createHost().host);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    // The terminal panel keeps its textarea this way, so a document-level check
    // would drop the card over live typing.
    expect(cardMounted()).toBe(false);

    blurEverything();
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("stays away during onboarding", async () => {
    seedRecord();
    start(createHost({ onboarding: true }).host);

    await vi.advanceTimersByTimeAsync(DWELL_MS * 2);
    await flushImport();
    expect(cardMounted()).toBe(false);
  });

  it("counts the load once the operator leaves onboarding", async () => {
    seedRecord();
    const shell = createHost({ onboarding: true });
    start(shell.host);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    expect(readStored().qualifiedLoads).toBe(1);

    // The gateway is already connected and the sessions list already published, so
    // leaving onboarding emits on neither: the shell only re-renders a new route.
    shell.leaveOnboarding();
    expect(readStored().qualifiedLoads).toBe(2);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("stays away for a settled operator", async () => {
    seedRecord({ settledAtMs: Date.now() - 1000, outcome: "dismissed" });
    start(createHost().host);

    await vi.advanceTimersByTimeAsync(DWELL_MS * 2);
    await flushImport();
    expect(cardMounted()).toBe(false);
  });

  it("settles the stored record when the card reports an outcome", async () => {
    seedRecord();
    start(createHost().host);
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();

    document.querySelector(CARD_TAG)?.dispatchEvent(
      new CustomEvent("community-invite-settled", {
        bubbles: true,
        detail: { outcome: "joined" },
      }),
    );

    const stored = readStored();
    expect(stored.outcome).toBe("joined");
    expect(stored.settledAtMs).toBeGreaterThan(0);
    expect(cardMounted()).toBe(false);
  });

  it("mounts one card when two tabs reach presentation together", async () => {
    installWebLocks();
    seedRecord();
    start(createHost().host);
    start(createHost().host);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    // Both schedulers are presentation-ready against the same record; the claim is
    // what stops the operator seeing the invite twice.
    expect(mountedCards()).toBe(1);
  });

  it("takes down a mounted card when another tab answers the invite", async () => {
    seedRecord();
    start(createHost().host);
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(true);

    // A foreign write arrives as a storage event, never as a local call.
    const settled = JSON.stringify({
      ...readStored(),
      settledAtMs: Date.now(),
      outcome: "joined",
    } satisfies CommunityInviteRecord);
    localStorage.setItem(STORAGE_KEY, settled);
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: settled }));

    expect(cardMounted()).toBe(false);
  });

  it("takes the card down when the shell disposes the scheduler", async () => {
    seedRecord();
    const dispose = start(createHost().host);
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(true);

    dispose();
    // A card outliving its owner keeps a detached shell's closures alive and lets a
    // reconnecting shell mount a second one beside it.
    expect(cardMounted()).toBe(false);
  });
});
