import { describe, expect, it } from "vitest";
import {
  readWorkflowBlueprintSearchParams,
  readWorkflowBlueprintSearchRequest,
} from "./blueprint-search-request";

describe("workflow blueprint search request parsing", () => {
  it("normalizes JSON request bodies without throwing on malformed fields", () => {
    expect(
      readWorkflowBlueprintSearchRequest({
        query: 123,
        category: "coding",
        tags: "acceptance",
        requiresCwd: "true",
        includeScript: "0",
        limit: "12",
      }),
    ).toEqual({
      category: "coding",
      requiresCwd: true,
      includeScript: false,
      limit: 12,
    });
  });

  it("reads valid tag arrays and URL search params", () => {
    expect(
      readWorkflowBlueprintSearchRequest({
        query: " loop ",
        tags: ["acceptance", "", 42, "rd"],
      }),
    ).toEqual({
      query: "loop",
      tags: ["acceptance", "rd"],
    });

    const params = new URLSearchParams({
      query: "acceptance",
      category: "coding",
      requiresCwd: "1",
      includeScript: "false",
      limit: "3",
    });
    params.append("tag", " loop ");
    params.append("tag", "rd");
    params.append("tag", " ");

    expect(readWorkflowBlueprintSearchParams(params)).toEqual({
      query: "acceptance",
      category: "coding",
      tags: ["loop", "rd"],
      requiresCwd: true,
      includeScript: false,
      limit: 3,
    });
  });
});
