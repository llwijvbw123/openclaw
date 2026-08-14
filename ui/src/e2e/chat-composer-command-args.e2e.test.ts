// Control UI E2E covers staged slash command arguments end to end.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI staged command arguments",
});

const ARTIFACT_DIR = path.resolve(".artifacts/control-ui-e2e/command-args");
const VIEWPORT = { height: 900, width: 1280 } as const;

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

function startupResponse(sessionId: string) {
  return {
    agentsList: {
      agents: [{ id: "main", name: "OpenClaw" }],
      defaultId: "main",
      mainKey: "main",
      scope: "agent" as const,
    },
    messages: [],
    metadata: { commands, models: [] },
    sessionId,
    thinkingLevel: null,
  };
}

suite.define(() => {
  for (const theme of ["light", "dark"] as const) {
    it(`stages composite command arguments without a chat turn (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["chat.send"],
          methodResponses: {
            "chat.startup": startupResponse(`staged-command-args-${theme}`),
            "commands.list": { commands },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        // Proves the forced color scheme actually reached the app shell, so a
        // "dark" artifact can never be a light screenshot with a dark filename.
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);

        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);

        // Phase 1: the command menu.
        await composer.fill("/deploy");
        const menu = page.locator(".slash-menu[role='listbox']");
        await menu.waitFor({ state: "visible" });
        await page.screenshot({
          animations: "disabled",
          path: path.join(ARTIFACT_DIR, `${theme}-1-command-menu.png`),
        });

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
        await page.screenshot({
          animations: "disabled",
          path: path.join(ARTIFACT_DIR, `${theme}-2-argument-choices.png`),
        });

        // Phase 3: picking the action chains to the value stage instead of running.
        await stageInput.press("ArrowDown");
        await stageInput.press("Enter");
        await expect
          .poll(() => page.locator(".slash-arg-stage__prefix").textContent())
          .toBe("/deploy scale");
        await expect
          .poll(() => stageInput.getAttribute("placeholder"))
          .toBe("Target replica count");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await page.screenshot({
          animations: "disabled",
          path: path.join(ARTIFACT_DIR, `${theme}-3-staged-value.png`),
        });

        // Phase 4: the assembled command runs once the last argument is supplied.
        await stageInput.fill("3");
        await page.screenshot({
          animations: "disabled",
          path: path.join(ARTIFACT_DIR, `${theme}-4-value-entered.png`),
        });
        await stageInput.press("Enter");
        await gateway.waitForRequest("chat.send");
        // Assert the whole dispatch set rather than only the first request: a
        // staged command must produce exactly one send carrying the assembled
        // command, so both a lost payload and a stray extra send show up here.
        // The payload field is `message`; asserting a field the request does not
        // carry silently reads as empty and fakes a product bug.
        expect(await gateway.getRequests("chat.send")).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({ message: "/deploy scale 3" }),
          }),
        ]);
        await expect.poll(() => page.locator(".slash-arg-stage").count()).toBe(0);
      });
    });
  }

  it("cancels a staged argument back into the message composer", async () => {
    await suite.withPage({ viewport: VIEWPORT }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.send"],
        methodResponses: {
          "chat.startup": startupResponse("staged-command-cancel"),
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
