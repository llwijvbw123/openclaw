/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMUNITY_INVITE_SETTLED_EVENT, COMMUNITY_INVITE_URL } from "./community-invite-dialog.ts";

const RESERVE_PROPERTY = "--oc-community-invite-reserve-bottom";
const CARD_HEIGHT = 300;

let card: HTMLElement;
let outcomes: string[];

/** jsdom has no ResizeObserver and no layout; the card needs both to publish the
 * height that keeps toasts off it. */
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
      unobserve() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    height: CARD_HEIGHT,
    width: 340,
    top: 0,
    left: 0,
    right: 340,
    bottom: CARD_HEIGHT,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  outcomes = [];
  card = document.createElement("openclaw-community-invite-dialog");
  card.addEventListener(COMMUNITY_INVITE_SETTLED_EVENT, (event) => {
    outcomes.push((event as CustomEvent<{ outcome: string }>).detail.outcome);
  });
  document.body.append(card);
});

afterEach(() => {
  card.remove();
  document.documentElement.style.removeProperty(RESERVE_PROPERTY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function shadowQuery<T extends Element>(selector: string): T {
  const found = card.shadowRoot?.querySelector<T>(selector);
  if (!found) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

describe("community invite card", () => {
  it("reserves its height so a toast stacks above instead of over it", () => {
    // The toast rule reads this property; without it the two floaters collide in
    // the same trailing corner.
    expect(document.documentElement.style.getPropertyValue(RESERVE_PROPERTY)).toBe(
      `${CARD_HEIGHT + 10}px`,
    );
  });

  it("releases the toast reserve when it goes away", () => {
    card.remove();
    expect(document.documentElement.style.getPropertyValue(RESERVE_PROPERTY)).toBe("");
  });

  it("is a non-modal complementary region, not a dialog", async () => {
    await card.updateComplete;
    const region = shadowQuery("aside.invite");
    expect(region.getAttribute("role")).toBe("complementary");
    // A focus trap or an aria-modal here would make it interrupt the operator.
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(card.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(card.shadowRoot?.querySelector("[autofocus]")).toBeNull();
  });

  it("dismisses from the close button", async () => {
    await card.updateComplete;
    shadowQuery<HTMLButtonElement>(".invite__close").click();
    expect(outcomes).toEqual(["dismissed"]);
  });

  it("dismisses on Escape while focus is inside the card", async () => {
    await card.updateComplete;
    shadowQuery(".invite").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(outcomes).toEqual(["dismissed"]);
  });

  it("settles as joined when the invite is opened in a new tab", async () => {
    await card.updateComplete;
    const cta = shadowQuery<HTMLAnchorElement>(".invite__cta");
    expect(cta.getAttribute("href")).toBe(COMMUNITY_INVITE_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toContain("noopener");
    cta.click();
    expect(outcomes).toEqual(["joined"]);
  });

  it("reports one outcome even when both exits fire", async () => {
    await card.updateComplete;
    shadowQuery<HTMLButtonElement>(".invite__close").click();
    shadowQuery<HTMLAnchorElement>(".invite__cta").click();
    expect(outcomes).toEqual(["dismissed"]);
  });
});
