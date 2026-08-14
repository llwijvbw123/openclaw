/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  communityInviteReadiness,
  isCommunityInviteSettled,
  readCommunityInviteRecord,
  recordQualifiedLoad,
} from "./community-invite.runtime.ts";
import {
  COMMUNITY_INVITE_KEY,
  communityInviteWasAnswered,
  type CommunityInviteRecord,
} from "./community-invite.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function record(overrides: Partial<CommunityInviteRecord> = {}): CommunityInviteRecord {
  return {
    firstQualifiedAtMs: NOW - 30 * DAY_MS,
    qualifiedLoads: 1,
    established: true,
    ...overrides,
  };
}

describe("recordQualifiedLoad", () => {
  it("classifies a browser that already sees sessions as an upgraded operator", () => {
    expect(recordQualifiedLoad(null, true, NOW)).toEqual({
      firstQualifiedAtMs: NOW,
      qualifiedLoads: 1,
      established: true,
    });
  });

  it("classifies a browser with no sessions as a fresh install", () => {
    expect(recordQualifiedLoad(null, false, NOW)).toEqual({
      firstQualifiedAtMs: NOW,
      qualifiedLoads: 1,
      established: false,
    });
  });

  it("keeps the original cohort and first sighting once classified", () => {
    const previous = record({ established: false, qualifiedLoads: 2 });
    // A fresh install that later grows sessions must not be promoted to the
    // upgrade cohort, or its evaluation window would be cut short.
    expect(recordQualifiedLoad(previous, true, NOW + DAY_MS)).toEqual({
      firstQualifiedAtMs: previous.firstQualifiedAtMs,
      qualifiedLoads: 3,
      established: false,
    });
  });

  it("preserves a settled outcome so a stray load cannot revive the card", () => {
    const settled = record({ settledAtMs: NOW - DAY_MS, outcome: "dismissed" });
    expect(recordQualifiedLoad(settled, true, NOW)).toMatchObject({
      settledAtMs: settled.settledAtMs,
      outcome: "dismissed",
    });
  });
});

describe("communityInviteReadiness", () => {
  const cases: ReadonlyArray<{
    name: string;
    record: CommunityInviteRecord;
    expected: "ready" | "waiting";
  }> = [
    {
      name: "upgraded operator waits out the first load of the new build",
      record: record({ established: true, qualifiedLoads: 1 }),
      expected: "waiting",
    },
    {
      name: "upgraded operator arms on the second qualified load",
      record: record({ established: true, qualifiedLoads: 2 }),
      expected: "ready",
    },
    {
      name: "fresh install waits while it is still young, even after many loads",
      record: record({
        established: false,
        qualifiedLoads: 9,
        firstQualifiedAtMs: NOW - DAY_MS,
      }),
      expected: "waiting",
    },
    {
      name: "fresh install waits while load count is short, even when old enough",
      record: record({
        established: false,
        qualifiedLoads: 2,
        firstQualifiedAtMs: NOW - 30 * DAY_MS,
      }),
      expected: "waiting",
    },
    {
      name: "fresh install arms once it is both old enough and used enough",
      record: record({
        established: false,
        qualifiedLoads: 3,
        firstQualifiedAtMs: NOW - 2 * DAY_MS,
      }),
      expected: "ready",
    },
    {
      name: "a settled record never arms again, however it was answered",
      record: record({ qualifiedLoads: 9, settledAtMs: NOW - DAY_MS, outcome: "joined" }),
      expected: "waiting",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(communityInviteReadiness(testCase.record, NOW)).toBe(testCase.expected);
    });
  }

  it("treats the two-day boundary as reached, not passed", () => {
    const boundary = record({
      established: false,
      qualifiedLoads: 3,
      firstQualifiedAtMs: NOW - 2 * DAY_MS,
    });
    expect(communityInviteReadiness(boundary, NOW)).toBe("ready");
    expect(communityInviteReadiness(boundary, NOW - 1)).toBe("waiting");
  });
});

describe("readCommunityInviteRecord", () => {
  afterEach(() => {
    localStorage.clear();
  });

  function storeRaw(raw: string): void {
    localStorage.setItem(COMMUNITY_INVITE_KEY, raw);
  }

  it("reads back a record it wrote", () => {
    const stored = record({ qualifiedLoads: 4 });
    storeRaw(JSON.stringify(stored));
    expect(readCommunityInviteRecord()).toEqual(stored);
  });

  const rejected: ReadonlyArray<{ name: string; raw: string }> = [
    { name: "a non-object payload", raw: '"settled"' },
    { name: "an array, which spreads into nonsense", raw: "[]" },
    // `{}` used to spread into the next write as `undefined + 1` qualified loads.
    { name: "an empty object with no counters at all", raw: "{}" },
    {
      name: "a non-finite first sighting, which would freeze the arming window",
      raw: JSON.stringify({ firstQualifiedAtMs: null, qualifiedLoads: 2, established: true }),
    },
    {
      name: "a fractional load count",
      raw: JSON.stringify({ firstQualifiedAtMs: NOW, qualifiedLoads: 1.5, established: true }),
    },
    {
      name: "a negative load count",
      raw: JSON.stringify({ firstQualifiedAtMs: NOW, qualifiedLoads: -1, established: true }),
    },
    {
      name: "a missing cohort flag",
      raw: JSON.stringify({ firstQualifiedAtMs: NOW, qualifiedLoads: 2 }),
    },
    {
      name: "a settlement carrying no outcome",
      raw: JSON.stringify({
        firstQualifiedAtMs: NOW,
        qualifiedLoads: 2,
        established: true,
        settledAtMs: NOW,
      }),
    },
    {
      name: "a settlement with an outcome outside the union",
      raw: JSON.stringify({
        firstQualifiedAtMs: NOW,
        qualifiedLoads: 2,
        established: true,
        settledAtMs: NOW,
        outcome: "ignored",
      }),
    },
    { name: "text that is not JSON at all", raw: "{not json" },
  ];

  for (const testCase of rejected) {
    it(`drops ${testCase.name}`, () => {
      storeRaw(testCase.raw);
      expect(readCommunityInviteRecord()).toBeNull();
    });
  }

  it("does not read a null settlement as settled, which would silence the card forever", () => {
    // `settledAtMs !== undefined` is what isCommunityInviteSettled asks, so a null
    // here used to be terminal for that browser with no way back.
    storeRaw(
      JSON.stringify({
        firstQualifiedAtMs: NOW,
        qualifiedLoads: 2,
        established: true,
        settledAtMs: null,
      }),
    );
    expect(isCommunityInviteSettled(readCommunityInviteRecord())).toBe(false);
  });
});

describe("communityInviteWasAnswered", () => {
  afterEach(() => {
    localStorage.clear();
  });

  // This probe is the startup-graph gate: answering true means the scheduler chunk
  // is never fetched again on this browser, so a wrong true is unrecoverable.
  const cases: ReadonlyArray<{ name: string; raw: string | null; expected: boolean }> = [
    { name: "no record at all", raw: null, expected: false },
    {
      name: "a whole settlement",
      raw: JSON.stringify({
        firstQualifiedAtMs: NOW,
        qualifiedLoads: 2,
        established: true,
        settledAtMs: NOW,
        outcome: "dismissed",
      }),
      expected: true,
    },
    {
      name: "a qualified but unanswered record",
      raw: JSON.stringify({ firstQualifiedAtMs: NOW, qualifiedLoads: 2, established: true }),
      expected: false,
    },
    {
      name: "a null settlement",
      raw: JSON.stringify({ settledAtMs: null, outcome: "joined" }),
      expected: false,
    },
    {
      name: "a settlement with no outcome",
      raw: JSON.stringify({ settledAtMs: NOW }),
      expected: false,
    },
    { name: "text that is not JSON at all", raw: "{not json", expected: false },
  ];

  for (const testCase of cases) {
    it(`${testCase.expected ? "short-circuits on" : "keeps going for"} ${testCase.name}`, () => {
      if (testCase.raw !== null) {
        localStorage.setItem(COMMUNITY_INVITE_KEY, testCase.raw);
      }
      expect(communityInviteWasAnswered()).toBe(testCase.expected);
    });
  }
});
