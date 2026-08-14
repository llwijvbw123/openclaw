// Composer argument staging: one stage per declared argument, never a chat turn.
import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { SLASH_COMMANDS, type SlashCommandDef } from "../../../lib/chat/commands.ts";
import {
  isSlashArgStageVisible,
  isSlashMenuVisible,
  renderSlashArgStage,
  renderSlashMenu,
  selectSlashCommand,
} from "./chat-composer-slash-menu.ts";
import { getChatComposerState, resetChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

const PANE_ID = "slash-arg-stage-pane";

type Harness = {
  props: ChatComposerProps;
  container: HTMLElement;
  requestUpdate: () => void;
  sent: string[];
  draft: () => string;
  stage: () => ReturnType<typeof getChatComposerState>["slashMenuStage"];
  input: () => HTMLInputElement | null;
  options: () => HTMLElement[];
  activeOption: () => HTMLElement | null;
};

function createHarness(options: { deferDraftPropagation?: boolean } = {}): Harness {
  const container = document.createElement("div");
  document.body.append(container);
  const sent: string[] = [];
  let draft = "";
  const props = {
    paneId: PANE_ID,
    // A getter keeps `props.draft` in step with the committed value, matching the
    // reactive host property the composer reads between renders.
    get draft() {
      return draft;
    },
    getDraft: () => draft,
    onDraftChange: (next: string) => {
      // The real draft is render-coupled: a same-tick send can read it before
      // the new value has propagated. This models that boundary.
      if (options.deferDraftPropagation) {
        queueMicrotask(() => {
          draft = next;
        });
        return;
      }
      draft = next;
    },
    // Mirrors the host send owner: an explicit text wins, otherwise the draft is
    // read at send time. Recording what the send route actually receives is what
    // makes an empty dispatch visible here rather than only in a browser run.
    onSend: (text?: string) => {
      sent.push(text ?? draft);
    },
  } as unknown as ChatComposerProps;

  const requestUpdate = () => {
    const state = getChatComposerState(PANE_ID);
    render(
      html`
        ${isSlashMenuVisible(state) ? renderSlashMenu(requestUpdate, props, "/") : nothing}
        ${isSlashArgStageVisible(state) ? renderSlashArgStage(requestUpdate, props) : nothing}
      `,
      container,
    );
  };

  return {
    props,
    container,
    requestUpdate,
    sent,
    draft: () => draft,
    stage: () => getChatComposerState(PANE_ID).slashMenuStage,
    input: () => container.querySelector<HTMLInputElement>(".slash-arg-stage__input"),
    options: () => [...container.querySelectorAll<HTMLElement>("[role='option']")],
    activeOption: () => container.querySelector<HTMLElement>(".slash-menu-item--active"),
  };
}

function requireCommand(name: string): SlashCommandDef {
  const command = SLASH_COMMANDS.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`missing slash command /${name}`);
  }
  return command;
}

function pressKey(harness: Harness, key: string): void {
  const input = harness.input();
  if (!input) {
    throw new Error(`no staged input to receive ${key}`);
  }
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function typeValue(harness: Harness, value: string): void {
  const input = harness.input();
  if (!input) {
    throw new Error("no staged input to type into");
  }
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function openCommand(harness: Harness, command: SlashCommandDef): void {
  selectSlashCommand(command, harness.props, harness.requestUpdate);
}

afterEach(() => {
  resetChatComposerState(PANE_ID);
  document.body.innerHTML = "";
});

describe("slash command argument staging", () => {
  it("runs an argument-free command straight from the menu", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("help"));

    expect(harness.stage()).toBeNull();
    expect(harness.sent).toEqual(["/help"]);
  });

  it("stages an enum argument instead of leaving a command line in the draft", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("tools"));

    expect(harness.draft()).toBe("");
    expect(harness.stage()?.index).toBe(0);
    expect(
      harness
        .options()
        .map((option) => option.querySelector(".slash-menu-name")?.textContent?.trim()),
    ).toEqual(["compact", "verbose"]);
    expect(harness.input()?.getAttribute("aria-label")).toBe("Value for mode");
    expect(harness.sent).toEqual([]);
  });

  it("offers resolved provider-dependent choices for /think", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("think"));

    expect(harness.stage()?.choices.map((choice) => choice.value)).toContain("high");
    expect(harness.options().length).toBeGreaterThan(1);
  });

  it("runs a single-argument command once its only choice is picked", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("tools"));
    pressKey(harness, "ArrowDown");
    pressKey(harness, "Enter");

    expect(harness.sent).toEqual(["/tools verbose"]);
    expect(harness.stage()).toBeNull();
  });

  it("chains a composite command instead of firing on the first choice", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("session"));
    pressKey(harness, "Enter");

    // The premature-dispatch bug: picking the action used to run the command.
    expect(harness.sent).toEqual([]);
    expect(harness.stage()?.index).toBe(1);
    expect(harness.container.querySelector(".slash-arg-stage__prefix")?.textContent).toBe(
      "/session idle",
    );
    expect(harness.input()?.getAttribute("placeholder")).toBe("Duration (24h, 90m) or off");

    typeValue(harness, "24h");
    pressKey(harness, "Enter");

    expect(harness.sent).toEqual(["/session idle 24h"]);
  });

  it("sends the assembled text even when draft propagation lags the send", () => {
    const harness = createHarness({ deferDraftPropagation: true });
    openCommand(harness, requireCommand("session"));
    pressKey(harness, "Enter");
    typeValue(harness, "24h");
    pressKey(harness, "Enter");

    // Writing the command to the draft and then calling a bare send dispatched
    // an empty message here, because the send read the draft in the same tick.
    expect(harness.sent).toEqual(["/session idle 24h"]);
  });

  it("accepts an empty optional trailing argument and runs what was collected", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("session"));
    pressKey(harness, "Enter");
    pressKey(harness, "Enter");

    expect(harness.sent).toEqual(["/session idle"]);
  });

  it("collects a free-form value for value-only commands", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("name"));

    expect(harness.stage()?.choices).toEqual([]);
    expect(harness.input()?.getAttribute("placeholder")).toBe(
      "New session name (omit to see a suggestion)",
    );

    typeValue(harness, "release prep");
    pressKey(harness, "Enter");

    expect(harness.sent).toEqual(["/name release prep"]);
  });

  it("refuses to run a required argument that is still empty", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("redirect"));
    pressKey(harness, "Enter");

    expect(harness.sent).toEqual([]);
    expect(harness.stage()?.index).toBe(0);

    typeValue(harness, "try again");
    pressKey(harness, "Enter");

    expect(harness.sent).toEqual(["/redirect try again"]);
  });

  it("advances with Tab only when the stage already has a value", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("session"));
    pressKey(harness, "Tab");
    pressKey(harness, "Tab");

    expect(harness.sent).toEqual([]);
    expect(harness.stage()?.index).toBe(1);

    typeValue(harness, "off");
    pressKey(harness, "Tab");

    expect(harness.sent).toEqual(["/session idle off"]);
  });

  it("steps Escape back one argument and then out to the composer", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("session"));
    pressKey(harness, "Enter");
    expect(harness.stage()?.index).toBe(1);

    pressKey(harness, "Escape");
    expect(harness.stage()?.index).toBe(0);
    expect(harness.stage()?.values).toEqual([]);

    pressKey(harness, "Escape");
    expect(harness.stage()).toBeNull();
    expect(harness.draft()).toBe("");
    expect(harness.sent).toEqual([]);
  });

  it("filters choices from the staged input and keeps the highlight in range", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("tools"));
    pressKey(harness, "ArrowDown");
    expect(harness.activeOption()?.textContent).toContain("verbose");

    typeValue(harness, "comp");
    expect(harness.options()).toHaveLength(1);
    expect(harness.activeOption()?.textContent).toContain("compact");

    pressKey(harness, "Enter");
    expect(harness.sent).toEqual(["/tools compact"]);
  });

  it("degrades a dynamic argument the catalog could not resolve to a value stage", () => {
    const harness = createHarness();
    openCommand(harness, {
      key: "plugin-think",
      name: "plugin-think",
      description: "Plugin thinking control.",
      argSpecs: [{ name: "level", description: "Thinking level", dynamic: true }],
    });

    expect(isSlashMenuVisible(getChatComposerState(PANE_ID))).toBe(false);
    expect(harness.input()?.getAttribute("placeholder")).toBe(
      "Options depend on the active model — type a value",
    );

    typeValue(harness, "high");
    pressKey(harness, "Enter");
    expect(harness.sent).toEqual(["/plugin-think high"]);
  });

  it("renders choice labels rather than raw values", () => {
    const harness = createHarness();
    openCommand(harness, {
      key: "plugin-fast",
      name: "plugin-fast",
      description: "Plugin fast mode.",
      argSpecs: [
        {
          name: "mode",
          description: "Fast mode",
          choices: [{ value: "auto", label: "auto (45 sec)" }],
        },
      ],
    });

    expect(harness.container.querySelector(".slash-menu-name")?.textContent).toBe("auto (45 sec)");
    pressKey(harness, "Enter");
    expect(harness.sent).toEqual(["/plugin-fast auto"]);
  });
});
