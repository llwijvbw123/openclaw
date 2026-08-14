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

let stop: (() => void) | null = null;
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

function createHost(sessionCount = 2): CommunityInviteHost {
  const gateway = { snapshot: { phase: "connected" }, subscribe: () => () => undefined };
  const sessions = {
    state: { result: { sessions: Array.from({ length: sessionCount }, () => ({})) } },
    subscribe: () => () => undefined,
  };
  return {
    context: { gateway, sessions },
    onboardingMode: false,
  } as unknown as CommunityInviteHost;
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

function cardMounted(): boolean {
  return document.querySelector(CARD_TAG) !== null;
}

/** Lets the scheduler's dynamic import settle without leaving fake timers behind. */
async function flushImport(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
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
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("community invite scheduler", () => {
  it("presents once the dwell elapses with the operator present", async () => {
    seedRecord();
    stop = runCommunityInvite(createHost());
    expect(cardMounted()).toBe(false);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("does not accrue dwell while the tab is hidden, and keeps no timer alive", async () => {
    seedRecord();
    stop = runCommunityInvite(createHost());
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
    stop = runCommunityInvite(createHost());

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
    stop = runCommunityInvite(createHost());

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();
    expect(cardMounted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    composer.blur();
    document.dispatchEvent(new Event("focusout"));
    await flushImport();
    expect(cardMounted()).toBe(true);
  });

  it("stays away during onboarding", async () => {
    seedRecord();
    const host = { ...createHost(), onboardingMode: true };
    stop = runCommunityInvite(host);

    await vi.advanceTimersByTimeAsync(DWELL_MS * 2);
    await flushImport();
    expect(cardMounted()).toBe(false);
  });

  it("stays away for a settled operator", async () => {
    seedRecord({ settledAtMs: Date.now() - 1000, outcome: "dismissed" });
    stop = runCommunityInvite(createHost());

    await vi.advanceTimersByTimeAsync(DWELL_MS * 2);
    await flushImport();
    expect(cardMounted()).toBe(false);
  });

  it("settles the stored record when the card reports an outcome", async () => {
    seedRecord();
    stop = runCommunityInvite(createHost());
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushImport();

    const card = document.querySelector(CARD_TAG);
    card?.dispatchEvent(
      new CustomEvent("community-invite-settled", {
        bubbles: true,
        detail: { outcome: "joined" },
      }),
    );

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as CommunityInviteRecord;
    expect(stored.outcome).toBe("joined");
    expect(stored.settledAtMs).toBeGreaterThan(0);
    expect(cardMounted()).toBe(false);
  });
});
