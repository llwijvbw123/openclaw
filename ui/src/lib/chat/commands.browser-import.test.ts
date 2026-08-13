// @vitest-environment node
import { describe, expect, it } from "vitest";

type CommandsModule = typeof import("./commands.js");
const browserImportPath = "./commands.ts?browser-import";

describe("slash command browser import", () => {
  it("builds fallback commands from the browser-safe shared registry", async () => {
    const mod = (await import(browserImportPath)) as CommandsModule;

    const thinkCommand = mod.SLASH_COMMANDS.find((command) => command.name === "think");
    expect(thinkCommand).toEqual({
      key: "think",
      name: "think",
      aliases: ["thinking", "t"],
      description: "Set thinking level.",
      category: "model",
      args: "[level]",
      icon: "brain",
      executeLocal: true,
      // Provider-dependent choices resolve from the browser-safe registry rather
      // than being dropped, so /think never advertises an empty option set.
      argSpecs: [
        {
          name: "level",
          description: "Thinking level",
          choices: [
            { value: "default", label: "default" },
            { value: "off", label: "off" },
            { value: "minimal", label: "minimal" },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" },
            { value: "adaptive", label: "adaptive" },
            { value: "max", label: "max" },
          ],
        },
      ],
      tier: "essential",
      source: "native",
    });
  });

  it("keeps the computed label for the /fast auto choice", async () => {
    const mod = (await import(browserImportPath)) as CommandsModule;

    const fastCommand = mod.SLASH_COMMANDS.find((command) => command.name === "fast");
    const modeChoices = fastCommand?.argSpecs?.[0]?.choices ?? [];
    expect(modeChoices.map((choice) => choice.value)).toEqual([
      "on",
      "off",
      "auto",
      "default",
      "status",
    ]);
    expect(modeChoices.find((choice) => choice.value === "auto")?.label).toMatch(
      /^auto \(\d+ sec\)$/u,
    );
  });
});
