import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runFlowV1CodeModule } from "@/lib/flow-v1/code-runner";
import { parseFlowV1Bundle } from "@/lib/flow-v1/parser";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";
import { getWorkflowBlueprint } from "./blueprint-catalog";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("official Blueprint behavior", () => {
  it("keeps delivery side effects and business terminal outcomes explicit", () => {
    for (const id of [
      "loop-primitive-rd-acceptance-test-v1",
      "rd-human-acceptance-delivery-v1",
      "repo-migration-sweep-v1",
    ]) {
      const blueprint = getWorkflowBlueprint(id);
      if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
        throw new Error(`Blueprint ${id} is unavailable.`);
      }
      const flow = parseFlowV1Bundle(blueprint.bundle);
      expect(flow.diagnostics, id).toEqual([]);
      expect(
        flow.nodes.filter((node) => node.kind === "effect").map((node) => node.id),
        id,
      ).toEqual(
        expect.arrayContaining([
          "prepare_workspace",
          "commit",
          "push",
          "create_pull_request",
        ]),
      );
      expect(
        flow.nodes
          .filter((node) => node.kind === "complete_cycle")
          .map((node) => node.terminalOutcome),
        id,
      ).toEqual(
        expect.arrayContaining([
          "accepted",
          "accepted_no_changes",
          "not_accepted",
        ]),
      );
    }
  });

  it("publishes one RD-ready pull request from the configured project cwd", () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }

    const flow = parseFlowV1Bundle(blueprint.bundle);
    expect(flow.diagnostics).toEqual([]);
    const workspace = flow.nodes.find(
      (node) => node.id === "prepare_workspace",
    );
    expect(workspace).toEqual(
      expect.objectContaining({
        kind: "effect",
        file: "scripts/prepare-branch.mjs",
        inputs: expect.objectContaining({
          preflight: expect.objectContaining({
            expression: "preflight",
          }),
          mainBranch: expect.objectContaining({
            expression: "params.mainBranch",
          }),
        }),
      }),
    );
    expect(workspace?.inputs).not.toHaveProperty("approval");
    expect(flow.secrets).toEqual({});

    const deliveryPreflight = flow.nodes.find(
      (node) => node.id === "preflight_delivery",
    );
    expect(deliveryPreflight).toEqual(
      expect.objectContaining({
        kind: "gate",
        file: "scripts/preflight-delivery.mjs",
        outcomes: ["ready"],
      }),
    );
    expect(deliveryPreflight?.secretNames).toBeUndefined();
    expect(deliveryPreflight?.retry).toBeUndefined();

    const plan = flow.nodes.find((node) => node.id === "plan_refactor");
    expect(plan).toEqual(
      expect.objectContaining({
        kind: "agent",
        session: { mode: "independent" },
        execution: { access: "review", isolation: "shared" },
        workspace: expect.objectContaining({ expression: "workspace" }),
        inputs: expect.objectContaining({
          candidate: expect.objectContaining({ expression: "candidate" }),
          lineThreshold: expect.objectContaining({
            expression: "params.lineThreshold",
          }),
        }),
        prompt: expect.stringMatching(
          /# 角色.*# Issue 正文要求.*仓库证据.*行为约束.*验证命令.*# 输出格式.*"title".*"body".*<target>/su,
        ),
      }),
    );
    expect(plan?.prompt).not.toContain("确认 HEAD");
    expect(plan?.prompt).not.toContain("{{sync.commit}}");
    expect(plan?.prompt).toContain("snapshot_commit: {{workspace.baseCommit}}");
    expect(plan?.output).toEqual(
      expect.objectContaining({
        kind: "json",
        schema: expect.objectContaining({
          required: ["title", "body"],
        }),
      }),
    );

    const rdWork = flow.nodes.find(
      (node) => node.id === "rd_work",
    );
    expect(rdWork).toEqual(
      expect.objectContaining({
        kind: "agent",
        label: "RD implement with independent sub-agent review",
        session: { mode: "independent" },
        execution: { access: "write", isolation: "shared" },
        prompt: expect.stringMatching(
          /# 角色.*独立、只读的 Sub-agent.*# 工作规则.*必须启动至少一个独立只读 Sub-agent.*不得把尚未发生的 commit.*只有实现和复审均满足 Issue 时才能返回 READY.*# 输出格式.*"status".*"summary".*issue_url: \{\{issue\.url\}\}/su,
        ),
        output: expect.objectContaining({
          kind: "json",
          schema: expect.objectContaining({
            required: ["status", "summary"],
          }),
        }),
      }),
    );
    expect(flow.nodes.filter((node) => node.kind === "loop")).toEqual([]);
    expect(
      flow.nodes.filter((node) => node.kind === "agent").map((node) => node.id),
    ).toEqual(["plan_refactor", "rd_work"]);

    const rdDecision = flow.nodes.find(
      (node) => node.id === "check_rd_delivery_status",
    );
    expect(rdDecision).toEqual(
      expect.objectContaining({
        kind: "gate",
        file: "scripts/rd-delivery-status.mjs",
        outcomes: ["ready", "blocked"],
        inputs: expect.objectContaining({
          rdWork: expect.objectContaining({ expression: "rdWork" }),
        }),
      }),
    );

    const publish = flow.nodes.find(
      (node) => node.id === "publish_rd_ready_pr",
    );
    expect(publish).toEqual(
      expect.objectContaining({
        kind: "effect",
        file: "scripts/publish-rd-ready-pr.mjs",
        execution: { access: "write", isolation: "shared" },
        inputs: expect.objectContaining({
          rdWork: expect.objectContaining({
            expression: "rdWork",
          }),
          rdDecision: expect.objectContaining({
            expression: "rdDecision",
          }),
          issue: expect.objectContaining({
            expression: "issue",
          }),
          workspace: expect.objectContaining({
            expression: "workspace",
          }),
        }),
      }),
    );
    expect(publish?.inputs).not.toHaveProperty("plan");
    expect(flow.nodes.some((node) => node.id === "sync_main")).toBe(false);
    expect(flow.nodes.some((node) => node.id === "cleanup_workspace")).toBe(
      false,
    );
    expect(
      blueprint.bundle.files.some(
        (file) =>
          file.path === "scripts/prepare-worktree.mjs" ||
          file.path === "scripts/cleanup-worktree.mjs",
      ),
    ).toBe(false);
    expect(
      flow.nodes.find((node) => node.id === "wait_pull_request_merge"),
    ).toEqual(
      expect.objectContaining({
        kind: "gate",
        outcomes: ["merged"],
      }),
    );
    expect(
      flow.nodes
        .map((node) => node.id)
        .filter((id) =>
          [
            "prepare_human_review",
            "human_delivery_review",
            "implement_plan",
            "rd_qa_acceptance",
            "qa_review",
            "qa_not_accepted_report",
            "close_qa_not_accepted_issue",
            "check_changes",
            "commit_changes",
            "push_branch",
            "create_pull_request",
          ].includes(id),
        ),
    ).toEqual([]);

    const controlEdges = flow.edges.filter((edge) => edge.kind === "control");
    expect(controlEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: "wait_issue_approval",
          outcome: "approved",
          targetNodeId: "rd_work",
        }),
        expect.objectContaining({
          sourceNodeId: "check_rd_delivery_status",
          outcome: "ready",
          targetNodeId: "publish_rd_ready_pr",
        }),
        expect.objectContaining({
          sourceNodeId: "check_rd_delivery_status",
          outcome: "blocked",
          targetNodeId: "implementation_blocked",
        }),
        expect.objectContaining({
          sourceNodeId: "wait_pull_request_merge",
          outcome: "merged",
          targetNodeId: "close_issue",
        }),
      ]),
    );
    expect(
      flow.nodes
        .filter((node) => node.kind === "complete_cycle")
        .map((node) => node.terminalOutcome),
    ).toContain("implementation_blocked");
    expect(
      flow.nodes
        .filter((node) => node.kind === "complete_cycle")
        .map((node) => node.terminalOutcome),
    ).not.toContain("delivery_rejected");
  });

  it("treats an empty large-file scan as a routable healthy outcome", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(
      path.join(tmpdir(), "large-file-blueprint-"),
    );
    temporaryDirectories.push(projectCwd);
    git(["init"], projectCwd);
    git(["config", "user.name", "Flow Test"], projectCwd);
    git(["config", "user.email", "flow@example.test"], projectCwd);
    writeFileSync(path.join(projectCwd, "small.ts"), "export const ok = true;\n");
    writeFileSync(
      path.join(projectCwd, "at-threshold.ts"),
      `${Array.from(
        { length: 10 },
        (_, index) => `export const exact${index} = ${index};`,
      ).join("\n")}\n`,
    );
    git(["add", "small.ts", "at-threshold.ts"], projectCwd);
    git(["commit", "-m", "small"], projectCwd);
    const smallCommit = git(["rev-parse", "HEAD"], projectCwd);
    const bin = path.join(projectCwd, "bin");
    mkdirSync(bin);
    const gitCalls = path.join(projectCwd, "git-calls.log");
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    const gitWrapper = path.join(bin, "git");
    writeFileSync(
      gitWrapper,
      `#!/bin/sh
echo "$*" >> ${JSON.stringify(gitCalls)}
exec "$REAL_GIT" "$@"
`,
    );
    chmodSync(gitWrapper, 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REAL_GIT: realGit,
    };

    const empty = await runFlowV1CodeModule({
      versionId: "large-file-empty",
      bundle: blueprint.bundle,
      file: "scripts/find-large-file.mjs",
      exportName: "run",
      context: { threshold: 10, root: "", sync: { commit: smallCommit } },
      environment,
      projectCwd,
    });
    expect(empty.value).toEqual({
      outcome: "empty",
      output: {
        reason: "No source file exceeds the configured threshold.",
      },
    });

    writeFileSync(
      path.join(projectCwd, "large.ts"),
      Array.from({ length: 12 }, (_, index) => `export const v${index} = ${index};`).join(
        "\n",
      ),
    );
    writeFileSync(
      path.join(projectCwd, "larger.test.ts"),
      Array.from(
        { length: 20 },
        (_, index) => `export const test${index} = ${index};`,
      ).join("\n"),
    );
    mkdirSync(path.join(projectCwd, "generated"));
    writeFileSync(
      path.join(projectCwd, "generated", "largest.ts"),
      Array.from(
        { length: 30 },
        (_, index) => `export const generated${index} = ${index};`,
      ).join("\n"),
    );
    git(
      ["add", "large.ts", "larger.test.ts", "generated/largest.ts"],
      projectCwd,
    );
    git(["commit", "-m", "large"], projectCwd);
    const largeCommit = git(["rev-parse", "HEAD"], projectCwd);
    const found = await runFlowV1CodeModule({
      versionId: "large-file-found",
      bundle: blueprint.bundle,
      file: "scripts/find-large-file.mjs",
      exportName: "run",
      context: { threshold: 10, root: "", sync: { commit: largeCommit } },
      environment,
      projectCwd,
    });
    expect(found.value).toEqual({
      outcome: "found",
      output: { path: "large.ts", lines: 12 },
    });
    const scannerGitCalls = readFileSync(gitCalls, "utf8")
      .trim()
      .split(/\r?\n/u);
    expect(scannerGitCalls).toHaveLength(2);
    expect(scannerGitCalls.every((call) => call.startsWith("grep "))).toBe(true);
    expect(scannerGitCalls.some((call) => call.includes(" show "))).toBe(false);
  });

  it("keeps GitHub gates waiting when status checks are temporarily unavailable", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(path.join(tmpdir(), "github-gate-blueprint-"));
    temporaryDirectories.push(projectCwd);
    const bin = path.join(projectCwd, "bin");
    mkdirSync(bin);
    const fakeGh = path.join(bin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\necho 'Get API: EOF' >&2\nexit 1\n");
    chmodSync(fakeGh, 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    const issue = await runFlowV1CodeModule({
      versionId: "large-file-issue-gate-unavailable",
      bundle: blueprint.bundle,
      file: "scripts/issue-approval.mjs",
      exportName: "check",
      context: {
        issue: { url: "https://github.com/example/project/issues/1" },
      },
      environment,
      projectCwd,
    });
    expect(issue.value).toEqual({
      status: "waiting",
      reason:
        "GitHub Issue status is temporarily unavailable; retry on the next Tick.",
    });

    const pullRequest = await runFlowV1CodeModule({
      versionId: "large-file-pr-gate-unavailable",
      bundle: blueprint.bundle,
      file: "scripts/pr-merged.mjs",
      exportName: "check",
      context: {
        pullRequest: {
          url: "https://github.com/example/project/pull/2",
        },
      },
      environment,
      projectCwd,
    });
    expect(pullRequest.value).toEqual({
      status: "waiting",
      reason:
        "GitHub Pull Request status is temporarily unavailable; retry on the next Tick.",
    });

    writeFileSync(
      fakeGh,
      "#!/bin/sh\necho '{\"state\":\"closed\",\"merged_at\":null,\"html_url\":\"https://github.com/example/project/pull/2\"}'\n",
    );
    const closedPullRequest = await runFlowV1CodeModule({
      versionId: "large-file-pr-gate-closed",
      bundle: blueprint.bundle,
      file: "scripts/pr-merged.mjs",
      exportName: "check",
      context: {
        pullRequest: {
          url: "https://github.com/example/project/pull/2",
        },
      },
      environment,
      projectCwd,
    });
    expect(closedPullRequest.value).toEqual({
      status: "waiting",
      reason:
        "Pull request was closed without merge; reopen and merge it before the Flow can continue.",
    });

    writeFileSync(
      fakeGh,
      "#!/bin/sh\necho 'HTTP 401: authentication required' >&2\nexit 1\n",
    );
    await expect(
      runFlowV1CodeModule({
        versionId: "large-file-issue-gate-auth-failure",
        bundle: blueprint.bundle,
        file: "scripts/issue-approval.mjs",
        exportName: "check",
        context: {
          issue: {
            approvalLabel: "flow-approved",
            url: "https://github.com/example/project/issues/1",
          },
        },
        environment,
        projectCwd,
      }),
    ).rejects.toMatchObject({ code: "flow_runner_exit_nonzero" });
  });

  it("approves an open labeled Issue and rejects a closed Issue", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(path.join(tmpdir(), "issue-approval-gate-"));
    temporaryDirectories.push(projectCwd);
    const bin = path.join(projectCwd, "bin");
    mkdirSync(bin);
    const fakeGh = path.join(bin, "gh");
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    const context = {
      issue: {
        approvalLabel: "flow-approved",
        url: "https://github.com/example/project/issues/1",
      },
    };

    writeFileSync(
      fakeGh,
      "#!/bin/sh\necho '{\"state\":\"open\",\"labels\":[{\"name\":\"flow-approved\"}],\"html_url\":\"https://github.com/example/project/issues/1\"}'\n",
    );
    chmodSync(fakeGh, 0o755);
    const approved = await runFlowV1CodeModule({
      versionId: "large-file-issue-approved",
      bundle: blueprint.bundle,
      file: "scripts/issue-approval.mjs",
      exportName: "check",
      context,
      environment,
      projectCwd,
    });
    expect(approved.value).toMatchObject({
      status: "completed",
      outcome: "approved",
      output: {
        state: "open",
        url: "https://github.com/example/project/issues/1",
      },
    });

    writeFileSync(
      fakeGh,
      "#!/bin/sh\necho '{\"state\":\"closed\",\"labels\":[{\"name\":\"flow-approved\"}],\"html_url\":\"https://github.com/example/project/issues/1\"}'\n",
    );
    const rejected = await runFlowV1CodeModule({
      versionId: "large-file-issue-rejected",
      bundle: blueprint.bundle,
      file: "scripts/issue-approval.mjs",
      exportName: "check",
      context,
      environment,
      projectCwd,
    });
    expect(rejected.value).toMatchObject({
      status: "completed",
      outcome: "rejected",
      output: {
        state: "closed",
        url: "https://github.com/example/project/issues/1",
      },
    });
  });

  it("preflights reusable repository state and idempotently prepares the approval label", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(path.join(tmpdir(), "flow-preflight-blueprint-"));
    temporaryDirectories.push(projectCwd);
    const bin = path.join(projectCwd, "bin");
    mkdirSync(bin);
    const fakeGit = path.join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
case "$*" in
  "--version") echo "git version 2.50.0" ;;
  "rev-parse --is-inside-work-tree") echo "true" ;;
  "remote get-url origin") echo "git@github.com:example/project.git" ;;
  "config --get user.name") echo "Flow Test" ;;
  "config --get user.email") echo "flow@example.test" ;;
  *) echo "unexpected git call: $*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(fakeGit, 0o755);
    const fakeGh = path.join(bin, "gh");
    const labelState = path.join(projectCwd, "label-created");
    const issueCall = path.join(projectCwd, "issue-call.txt");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
state=${JSON.stringify(labelState)}
issue_call=${JSON.stringify(issueCall)}
case "$1 $2" in
  "api user") echo 'SingleMai' ;;
  "label create") touch "$state"; exit 0 ;;
  "issue create") printf '%s' "$*" > "$issue_call"; echo 'https://github.com/example/project/issues/1' ;;
  "api repos/example/project/labels/flow-approved")
    if test -f "$state"; then
      echo '{"name":"flow-approved"}'
    else
      echo 'HTTP 404: Not Found' >&2
      exit 1
    fi
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    const preflight = await runFlowV1CodeModule({
      versionId: "large-file-preflight",
      bundle: blueprint.bundle,
      file: "scripts/preflight-environment.mjs",
      exportName: "run",
      context: { branch: "main" },
      environment,
      projectCwd,
    });
    expect(preflight.value).toEqual({
      branch: "main",
      remote: "origin",
      repository: "example/project",
    });

    const deliveryReady = await runFlowV1CodeModule({
      versionId: "large-file-delivery-preflight",
      bundle: blueprint.bundle,
      file: "scripts/preflight-delivery.mjs",
      exportName: "check",
      context: {
        candidate: { path: "src/large.ts", lines: 1500 },
        preflight: preflight.value,
      },
      environment,
      projectCwd,
    });
    expect(deliveryReady.value).toEqual({
      status: "completed",
      outcome: "ready",
      output: {
        repository: "example/project",
        login: "SingleMai",
      },
    });

    const labelContext = {
      deliveryReady: (
        deliveryReady.value as {
          output: FlowV1JsonObject;
        }
      ).output,
      label: "flow-approved",
      plan: { title: "Split module" },
    };
    const applied = await runFlowV1CodeModule({
      versionId: "large-file-label-apply",
      bundle: blueprint.bundle,
      file: "scripts/ensure-approval-label.mjs",
      exportName: "apply",
      context: labelContext,
      environment,
      projectCwd,
    });
    expect(applied.value).toEqual({
      externalRef: "example/project:flow-approved",
      output: {
        name: "flow-approved",
        repository: "example/project",
      },
    });
    const reconciled = await runFlowV1CodeModule({
      versionId: "large-file-label-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/ensure-approval-label.mjs",
      exportName: "reconcile",
      context: labelContext,
      environment,
      projectCwd,
    });
    expect(reconciled.value).toEqual({
      status: "completed",
      externalRef: "example/project:flow-approved",
      output: {
        name: "flow-approved",
        repository: "example/project",
      },
    });

    const issue = await runFlowV1CodeModule({
      versionId: "large-file-readable-issue",
      bundle: blueprint.bundle,
      file: "scripts/create-issue.mjs",
      exportName: "apply",
      context: {
        approvalLabel: { name: "flow-approved" },
        cycle: { id: "cycle-readable-issue" },
        plan: {
          title: "Extract focused modules",
          body: [
            "## Candidate",
            "`src/large.ts` — 1500 lines",
            "",
            "## Repository evidence",
            "- `src/large.ts:40` mixes parsing and storage.",
            "",
            "## Plan",
            "1. Extract focused helpers.",
            "",
            "## Validation",
            "- [ ] Run focused unit tests.",
          ].join("\n"),
        },
      },
      environment,
      projectCwd,
    });
    expect(issue.value).toEqual({
      externalRef: "https://github.com/example/project/issues/1",
      output: {
        approvalLabel: "flow-approved",
        marker: "[flow:cycle-readable-issue]",
        title: "[flow:cycle-readable-issue] Extract focused modules",
        url: "https://github.com/example/project/issues/1",
      },
    });
    const issueArguments = readFileSync(issueCall, "utf8");
    expect(issueArguments).toContain("## Candidate");
    expect(issueArguments).toContain("## Repository evidence");
    expect(issueArguments).toContain("## Plan");
    expect(issueArguments).toContain("## Validation");
    expect(issueArguments).toContain("flow-approved");
    expect(issueArguments).toContain(
      "read the latest Issue body and comments as the source of truth",
    );
  });

  it("routes RD READY and BLOCKED results without a Flow-level review loop", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(path.join(tmpdir(), "flow-rd-status-"));
    temporaryDirectories.push(projectCwd);

    for (const [status, outcome] of [
      ["READY", "ready"],
      ["BLOCKED", "blocked"],
    ] as const) {
      const result = await runFlowV1CodeModule({
        versionId: `large-file-rd-${outcome}`,
        bundle: blueprint.bundle,
        file: "scripts/rd-delivery-status.mjs",
        exportName: "check",
        context: {
          rdWork: {
            status,
            summary: `${status} summary`,
          },
        },
        projectCwd,
      });
      expect(result.value).toEqual({
        status: "completed",
        outcome,
        output: {
          status,
          summary: `${status} summary`,
        },
      });
    }
  });

  it("publishes one pull request containing the RD and sub-agent conclusion", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const root = mkdtempSync(path.join(tmpdir(), "flow-rd-publish-"));
    temporaryDirectories.push(root);
    const remote = path.join(root, "remote.git");
    const projectCwd = path.join(root, "project");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    git(["init", "--bare", remote], root);
    git(["init", projectCwd], root);
    git(["config", "user.name", "Flow Test"], projectCwd);
    git(["config", "user.email", "flow@example.test"], projectCwd);
    writeFileSync(path.join(projectCwd, "source.ts"), "export const value = 1;\n");
    git(["add", "source.ts"], projectCwd);
    git(["commit", "-m", "initial"], projectCwd);
    git(["branch", "-M", "main"], projectCwd);
    git(["remote", "add", "origin", remote], projectCwd);
    git(["push", "-u", "origin", "main"], projectCwd);
    const branch = "flow/large-file-cycle-publis";
    git(["checkout", "-b", branch], projectCwd);
    writeFileSync(path.join(projectCwd, "source.ts"), "export const value = 2;\n");

    const fakeGh = path.join(bin, "gh");
    const prState = path.join(root, "pr-created");
    const prCall = path.join(root, "pr-call.txt");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
state=${JSON.stringify(prState)}
call=${JSON.stringify(prCall)}
case "$1 $2" in
  "pr list")
    if test -f "$state"; then
      echo '[{"url":"https://github.com/example/project/pull/9","headRefName":"${branch}","baseRefName":"main"}]'
    else
      echo '[]'
    fi
    ;;
  "pr create")
    printf '%s' "$*" > "$call"
    touch "$state"
    echo 'https://github.com/example/project/pull/9'
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);
    const context = {
      rdWork: {
        status: "READY",
        summary: [
          "RD completed the implementation and independent sub-agent review.",
          "",
          "## Checks",
          "- `pnpm vitest run source.test.ts` — passed",
        ].join("\n"),
      },
      rdDecision: { status: "READY" },
      candidate: { path: "source.ts", lines: 1500 },
      cycle: { id: "cycle-publish", sequence: 1 },
      issue: { url: "https://github.com/example/project/issues/4" },
      mainBranch: "main",
      workspace: { branch, path: projectCwd },
    };
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    const published = await runFlowV1CodeModule({
      versionId: "large-file-publish-rd-ready",
      bundle: blueprint.bundle,
      file: "scripts/publish-rd-ready-pr.mjs",
      exportName: "apply",
      context,
      environment,
      projectCwd,
    });
    const publishOutput = readOutputObject(published.value);
    expect(publishOutput).toEqual(
      expect.objectContaining({
        url: "https://github.com/example/project/pull/9",
        branch,
        rdSummary: expect.stringContaining(
          "RD completed the implementation and independent sub-agent review.",
        ),
      }),
    );
    expect(readFileSync(prCall, "utf8")).toContain("## Source Issue");
    expect(readFileSync(prCall, "utf8")).toContain(
      "https://github.com/example/project/issues/4",
    );
    expect(readFileSync(prCall, "utf8")).toContain(
      "## RD Implementation and Sub-agent Review",
    );
    expect(readFileSync(prCall, "utf8")).toContain(
      "RD completed the implementation and independent sub-agent review.",
    );
    expect(readFileSync(prCall, "utf8")).toContain(
      "Closes https://github.com/example/project/issues/4",
    );
    expect(git(["ls-remote", "origin", `refs/heads/${branch}`], projectCwd)).toContain(
      String(publishOutput.commit),
    );

    const reconciled = await runFlowV1CodeModule({
      versionId: "large-file-publish-rd-ready-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/publish-rd-ready-pr.mjs",
      exportName: "reconcile",
      context,
      environment,
      projectCwd,
    });
    expect(reconciled.value).toMatchObject({
      status: "completed",
      output: {
        url: "https://github.com/example/project/pull/9",
        branch,
        commit: publishOutput.commit,
      },
    });
  });

  it("uses the configured cwd and refreshes each serial Cycle from origin/main", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const root = mkdtempSync(path.join(tmpdir(), "flow-shared-cwd-blueprint-"));
    temporaryDirectories.push(root);
    const remote = path.join(root, "remote.git");
    const projectCwd = path.join(root, "project");
    const upstreamCwd = path.join(root, "upstream");
    git(["init", "--bare", remote], root);
    git(["init", projectCwd], root);
    git(["config", "user.name", "Flow Test"], projectCwd);
    git(["config", "user.email", "flow@example.test"], projectCwd);
    writeFileSync(path.join(projectCwd, "source.ts"), "export const value = 1;\n");
    git(["add", "source.ts"], projectCwd);
    git(["commit", "-m", "initial"], projectCwd);
    git(["branch", "-M", "main"], projectCwd);
    git(["remote", "add", "origin", remote], projectCwd);
    git(["push", "-u", "origin", "main"], projectCwd);
    const initialCommit = git(["rev-parse", "HEAD"], projectCwd);

    const firstCycle = {
      cycle: { id: "11111111-1111-4111-8111-111111111111", sequence: 1 },
      mainBranch: "main",
      preflight: { branch: "main", remote: "origin" },
    };
    const firstPrepared = await runFlowV1CodeModule({
      versionId: "large-file-shared-cwd-first",
      bundle: blueprint.bundle,
      file: "scripts/prepare-branch.mjs",
      exportName: "apply",
      context: firstCycle,
      projectCwd,
    });
    const firstWorkspace = readOutputObject(firstPrepared.value);
    expect(firstWorkspace).toEqual({
      path: realpathSync(projectCwd),
      branch: "flow/large-file-11111111-111",
      mainBranch: "main",
      baseCommit: initialCommit,
      commit: initialCommit,
    });
    expect(git(["branch", "--show-current"], projectCwd)).toBe(
      firstWorkspace.branch,
    );
    expect(
      existsSync(path.join(projectCwd, ".tutti-flow-worktrees")),
    ).toBe(false);

    const reconciled = await runFlowV1CodeModule({
      versionId: "large-file-shared-cwd-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/prepare-branch.mjs",
      exportName: "reconcile",
      context: firstCycle,
      projectCwd,
    });
    expect(reconciled.value).toMatchObject({
      status: "completed",
      output: firstWorkspace,
    });

    git(["clone", "--branch", "main", remote, upstreamCwd], root);
    git(["config", "user.name", "Flow Test"], upstreamCwd);
    git(["config", "user.email", "flow@example.test"], upstreamCwd);
    writeFileSync(path.join(upstreamCwd, "upstream.ts"), "export const fresh = true;\n");
    git(["add", "upstream.ts"], upstreamCwd);
    git(["commit", "-m", "upstream change"], upstreamCwd);
    git(["push", "origin", "main"], upstreamCwd);
    const latestRemoteCommit = git(["rev-parse", "HEAD"], upstreamCwd);

    const secondCycle = {
      cycle: { id: "22222222-2222-4222-8222-222222222222", sequence: 2 },
      mainBranch: "main",
      preflight: { branch: "main", remote: "origin" },
    };
    const secondPrepared = await runFlowV1CodeModule({
      versionId: "large-file-shared-cwd-second",
      bundle: blueprint.bundle,
      file: "scripts/prepare-branch.mjs",
      exportName: "apply",
      context: secondCycle,
      projectCwd,
    });
    const secondWorkspace = readOutputObject(secondPrepared.value);
    expect(secondWorkspace).toMatchObject({
      path: realpathSync(projectCwd),
      branch: "flow/large-file-22222222-222",
      mainBranch: "main",
      baseCommit: latestRemoteCommit,
      commit: latestRemoteCommit,
    });
    expect(git(["rev-parse", "HEAD"], projectCwd)).toBe(latestRemoteCommit);
    expect(readFileSync(path.join(projectCwd, "upstream.ts"), "utf8")).toBe(
      "export const fresh = true;\n",
    );

    writeFileSync(path.join(projectCwd, "dirty.ts"), "do not discard\n");
    await expect(
      runFlowV1CodeModule({
        versionId: "large-file-shared-cwd-dirty",
        bundle: blueprint.bundle,
        file: "scripts/prepare-branch.mjs",
        exportName: "apply",
        context: {
          cycle: {
            id: "33333333-3333-4333-8333-333333333333",
            sequence: 3,
          },
          mainBranch: "main",
          preflight: { branch: "main", remote: "origin" },
        },
        projectCwd,
      }),
    ).rejects.toMatchObject({ code: "flow_runner_exit_nonzero" });
  });

  it("stores a compact completed-cycle memory summary", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(path.join(tmpdir(), "flow-memory-blueprint-"));
    temporaryDirectories.push(projectCwd);
    const memory = await runFlowV1CodeModule({
      versionId: "large-file-memory-summary",
      bundle: blueprint.bundle,
      file: "scripts/build-memory-update.mjs",
      exportName: "run",
      context: {
        candidate: { path: "src/large.ts", lines: 1500 },
        cycle: { id: "cycle-1" },
        issue: { url: "https://github.com/example/project/issues/1" },
        merged: { mergedAt: "2026-07-26T00:00:00.000Z" },
        pullRequest: { url: "https://github.com/example/project/pull/2" },
      },
      projectCwd,
    });
    expect(memory.value).toEqual({
      currentUnderstanding: [
        "Last completed candidate: src/large.ts (1500 lines before refactor)",
        "Issue: https://github.com/example/project/issues/1",
        "Pull request: https://github.com/example/project/pull/2",
        "Merged: true",
      ].join("\n"),
      decision:
        "Cycle cycle-1: delivered src/large.ts via https://github.com/example/project/issues/1",
      timeline:
        "Cycle cycle-1: merged https://github.com/example/project/pull/2",
    });
    expect(JSON.stringify(memory.value)).not.toContain("Plan:");
  });

  it("reconciles commit and push delivery effects independently", async () => {
    const blueprint = getWorkflowBlueprint(
      "loop-primitive-rd-acceptance-test-v1",
    );
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("RD delivery Blueprint is unavailable.");
    }
    const root = mkdtempSync(path.join(tmpdir(), "delivery-effects-"));
    temporaryDirectories.push(root);
    const remote = path.join(root, "remote.git");
    const projectCwd = path.join(root, "project");
    git(["init", "--bare", remote], root);
    git(["init", projectCwd], root);
    git(["config", "user.name", "Flow Test"], projectCwd);
    git(["config", "user.email", "flow@example.test"], projectCwd);
    writeFileSync(path.join(projectCwd, "README.md"), "initial\n");
    git(["add", "README.md"], projectCwd);
    git(["commit", "-m", "initial"], projectCwd);
    git(["branch", "-M", "main"], projectCwd);
    git(["remote", "add", "origin", remote], projectCwd);
    git(["push", "-u", "origin", "main"], projectCwd);

    const cycle = { id: "cycle-delivery-test", sequence: 7 };
    const prepared = await runFlowV1CodeModule({
      versionId: "delivery-workspace",
      bundle: blueprint.bundle,
      file: "scripts/prepare-delivery-workspace.mjs",
      exportName: "apply",
      context: { cycle, targetBranch: "main" },
      projectCwd,
    });
    const workspace = readOutputObject(prepared.value);
    writeFileSync(path.join(String(workspace.path), "change.txt"), "changed\n");

    const committed = await runFlowV1CodeModule({
      versionId: "delivery-commit",
      bundle: blueprint.bundle,
      file: "scripts/commit-delivery.mjs",
      exportName: "apply",
      context: { cycle, title: "test: delivery", workspace },
      projectCwd: String(workspace.path),
    });
    const commit = readOutputObject(committed.value);
    const reconciledCommit = await runFlowV1CodeModule({
      versionId: "delivery-commit-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/commit-delivery.mjs",
      exportName: "reconcile",
      context: { cycle, title: "test: delivery", workspace },
      projectCwd: String(workspace.path),
    });
    expect(reconciledCommit.value).toMatchObject({
      status: "completed",
      output: { sha: commit.sha },
    });

    const pushed = await runFlowV1CodeModule({
      versionId: "delivery-push",
      bundle: blueprint.bundle,
      file: "scripts/push-delivery.mjs",
      exportName: "apply",
      context: { cycle, commit, workspace },
      projectCwd: String(workspace.path),
    });
    const push = readOutputObject(pushed.value);
    const reconciledPush = await runFlowV1CodeModule({
      versionId: "delivery-push-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/push-delivery.mjs",
      exportName: "reconcile",
      context: { cycle, commit, workspace },
      projectCwd: String(workspace.path),
    });
    expect(reconciledPush.value).toMatchObject({
      status: "completed",
      output: { branch: push.branch, sha: commit.sha },
    });
  });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readOutputObject(
  value: Awaited<ReturnType<typeof runFlowV1CodeModule>>["value"],
): FlowV1JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.output !== "object" ||
    value.output === null ||
    Array.isArray(value.output)
  ) {
    throw new Error("Expected a code-module result with an object output.");
  }
  return value.output;
}
