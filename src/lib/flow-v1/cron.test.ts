import { describe, expect, it } from "vitest";
import {
  FlowV1CronError,
  nextFlowV1CronFire,
  validateFlowV1Cron,
} from "./cron";

describe("Flow v1 cron", () => {
  it("computes the next fire in an IANA timezone", () => {
    expect(
      nextFlowV1CronFire({
        expression: "0 9 * * *",
        timezone: "Asia/Singapore",
        after: "2026-07-26T00:30:00.000Z",
      }),
    ).toBe("2026-07-26T01:00:00.000Z");
  });

  it("supports lists, ranges, and steps", () => {
    expect(
      nextFlowV1CronFire({
        expression: "*/15 9-10 * * 1,2,3,4,5",
        timezone: "UTC",
        after: "2026-07-27T09:01:00.000Z",
      }),
    ).toBe("2026-07-27T09:15:00.000Z");
  });

  it("rejects invalid fields and timezones", () => {
    expect(() => validateFlowV1Cron("61 9 * * *")).toThrow(
      FlowV1CronError,
    );
    expect(() =>
      nextFlowV1CronFire({
        expression: "0 9 * * *",
        timezone: "Invalid/Zone",
        after: new Date(),
      }),
    ).toThrow(/Invalid IANA timezone/u);
  });
});
