// Control UI E2E covers staged slash command arguments end to end.
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI staged command arguments",
});

/**
 * `/deploy` mirrors the composite shape of the built-in `/session`: a choice for
 * the action, then a free-form value the operator has to supply.
 */
const commands = [
  {
    acceptsArgs: true,
    args: [
      {
        choices: [
          { label: "Restart", value: "restart" },
          { label: "Scale", value: "scale" },
        ],
        description: "Deploy action",
        name: "action",
        type: "string",
      },
      { description: "Target replica count", name: "value", type: "string" },
    ],
    category: "management",
    description: "Manage a deployment.",
    name: "deploy",
    scope: "both",
    source: "plugin",
    textAliases: ["/deploy"],
  },
  {
    acceptsArgs: true,
    args: [{ description: "Note to record", name: "note", required: true, type: "string" }],
    category: "session",
    description: "Record a note.",
    name: "note",
    scope: "both",
    source: "plugin",
    textAliases: ["/note"],
  },
];

suite.define(() => {
  it("stages composite and free-form command arguments without a chat turn", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.send"],
        methodResponses: {
          "chat.startup": {
            agentsList: {
              agents: [{ id: "main", name: "OpenClaw" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            messages: [],
            metadata: { commands, models: [] },
            sessionId: "staged-command-args-session",
            thinkingLevel: null,
          },
          "commands.list": { commands },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await expect.poll(() => composer.isEnabled()).toBe(true);

      // Phase 1: the command menu.
      await composer.fill("/deploy");
      const menu = page.locator(".slash-menu[role='listbox']");
      await menu.waitFor({ state: "visible" });
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "command-args-1-menu.png") });
      }

      // Phase 2: the action choices, rendered by label.
      await composer.press("Enter");
      const stageInput = page.locator(".slash-arg-stage__input");
      await stageInput.waitFor({ state: "visible" });
      await expect
        .poll(() => menu.getByRole("option").locator(".slash-menu-name").allTextContents())
        .toEqual(["Restart", "Scale"]);
      // The chosen command never lands in the message textarea.
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect
        .poll(() => stageInput.evaluate((node) => document.activeElement === node))
        .toBe(true);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "command-args-2-choices.png") });
      }

      // Phase 3: picking the action chains to the value stage instead of running.
      await stageInput.press("ArrowDown");
      await stageInput.press("Enter");
      await expect
        .poll(() => page.locator(".slash-arg-stage__prefix").textContent())
        .toBe("/deploy scale");
      await expect.poll(() => stageInput.getAttribute("placeholder")).toBe("Target replica count");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "command-args-3-staged-value.png") });
      }

      // Phase 4: the assembled command runs once the last argument is supplied.
      await stageInput.fill("3");
      await stageInput.press("Enter");
      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(
        typeof sendRequest.params === "object" &&
          sendRequest.params !== null &&
          "text" in sendRequest.params
          ? sendRequest.params.text
          : "",
      ).toBe("/deploy scale 3");
      await expect.poll(() => page.locator(".slash-arg-stage").count()).toBe(0);
    });
  });

  it("cancels a staged argument back into the message composer", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.send"],
        methodResponses: {
          "chat.startup": {
            agentsList: {
              agents: [{ id: "main", name: "OpenClaw" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            messages: [],
            metadata: { commands, models: [] },
            sessionId: "staged-command-cancel-session",
            thinkingLevel: null,
          },
          "commands.list": { commands },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await composer.fill("/note");
      await page.locator(".slash-menu[role='listbox']").waitFor({ state: "visible" });
      await composer.press("Enter");

      const stageInput = page.locator(".slash-arg-stage__input");
      await stageInput.waitFor({ state: "visible" });
      // A required argument must not dispatch while it is still empty.
      await stageInput.press("Enter");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await stageInput.press("Escape");
      await expect.poll(() => page.locator(".slash-arg-stage").count()).toBe(0);
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect
        .poll(() => composer.evaluate((node) => document.activeElement === node))
        .toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
