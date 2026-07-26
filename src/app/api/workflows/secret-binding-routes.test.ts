import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-api-binding-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("workflow Secret binding routes", () => {
  it("returns 400 for a malformed binding during creation", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          bundle: { files: [] },
          secretBindings: { GH_TOKEN: null },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Secret bindings must use a supported binding shape.",
        }),
      }),
    );
  });

  it("returns 400 for a malformed binding during configuration", async () => {
    const { PATCH } = await import("./[id]/route");
    const response = await PATCH(
      new Request("http://localhost/api/workflows/flow-1", {
        method: "PATCH",
        body: JSON.stringify({
          secretBindings: { GH_TOKEN: null },
        }),
      }),
      { params: Promise.resolve({ id: "flow-1" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Secret bindings must use a supported binding shape.",
        }),
      }),
    );
  });

  it("returns 400 when a connection binding does not match the creation schema", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      workflowRequest("http://localhost/api/workflows", {
        bundle: stringSecretBundle(),
        secretBindings: {
          API_TOKEN: githubConnectionBinding(),
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Secret API_TOKEN does not accept a connection binding.",
        }),
      }),
    );
  });

  it("returns 400 when a connection binding does not match the update schema", async () => {
    const { POST } = await import("./route");
    const createdResponse = await POST(
      workflowRequest("http://localhost/api/workflows", {
        bundle: stringSecretBundle(),
      }),
    );
    const created = (await createdResponse.json()) as { flowId: string };
    const { PATCH } = await import("./[id]/route");

    const response = await PATCH(
      workflowRequest(
        `http://localhost/api/workflows/${created.flowId}`,
        {
          secretBindings: {
            API_TOKEN: githubConnectionBinding(),
          },
        },
        "PATCH",
      ),
      { params: Promise.resolve({ id: created.flowId }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Secret API_TOKEN does not accept a connection binding.",
        }),
      }),
    );
  });

  it("rejects prototype-chain names that are not declared Secrets", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      workflowRequest("http://localhost/api/workflows", {
        bundle: stringSecretBundle(),
        secretBindings: {
          toString: {
            kind: "environment",
            env: "FLOW_TEST_TOKEN",
          },
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message:
            "Secret binding toString does not match a declared Flow Secret.",
        }),
      }),
    );
  });
});

function workflowRequest(
  url: string,
  body: unknown,
  method = "POST",
): Request {
  return new Request(url, {
    method,
    body: JSON.stringify(body),
  });
}

function stringSecretBundle() {
  return {
    files: [
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          export const secrets = defineSecrets({
            API_TOKEN: stringSecret({ required: false }),
          });
          completeCycle({ id: "done" });
        `,
      },
    ],
  };
}

function githubConnectionBinding() {
  return {
    kind: "connection",
    provider: "github",
    source: "github_cli",
    host: "github.com",
    login: "octocat",
  };
}
