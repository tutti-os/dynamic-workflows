import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

  it("publishes one QA-approved pull request after the RD and QA repair loop", () => {
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
        inputs: expect.objectContaining({
          deliveryReady: expect.objectContaining({
            expression: "deliveryReady",
          }),
          sync: expect.objectContaining({ expression: "sync" }),
        }),
      }),
    );
    expect(workspace?.inputs).not.toHaveProperty("approval");

    const plan = flow.nodes.find((node) => node.id === "plan_refactor");
    expect(plan).toEqual(
      expect.objectContaining({
        kind: "agent",
        session: { mode: "independent" },
        execution: { access: "review", isolation: "required" },
        workspace: expect.objectContaining({ expression: "workspace" }),
        inputs: expect.objectContaining({
          candidate: expect.objectContaining({ expression: "candidate" }),
          sync: expect.objectContaining({ expression: "sync" }),
          lineThreshold: expect.objectContaining({
            expression: "params.lineThreshold",
          }),
        }),
        prompt: expect.stringMatching(
          /# 角色.*# 分析要求.*# 证据标准.*evidence.*affectedFiles.*behaviorInvariants.*unknowns.*# 约束.*<target>/su,
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
          required: expect.arrayContaining([
            "responsibilities",
            "evidence",
            "affectedFiles",
            "behaviorInvariants",
            "unknowns",
          ]),
        }),
      }),
    );

    const acceptance = flow.nodes.find(
      (node) => node.id === "rd_qa_acceptance",
    );
    expect(acceptance).toEqual(
      expect.objectContaining({
        kind: "loop",
        execution: { access: "write", isolation: "required" },
        outcomes: ["matched", "exhausted"],
      }),
    );
    expect(acceptance?.loop).toEqual(
      expect.objectContaining({
        onMaxIterations: "complete",
        until: { source: "qa_review", finalStatus: "PASS" },
      }),
    );
    expect(acceptance?.loop?.steps.map((step) => step.id)).toEqual([
      "rd_work",
      "qa_review",
    ]);
    expect(acceptance?.loop?.steps[0]).toEqual(
      expect.objectContaining({
        label: "RD implement or repair",
        session: { mode: "inherit", key: "rd_room" },
        prompt: expect.stringMatching(
          /# 角色.*# 工作规则.*# 约束.*<context>/su,
        ),
        appendPrompt: expect.stringMatching(
          /# 本轮任务.*只处理 blockers.*suggestions 仅供参考.*<qa_feedback>/su,
        ),
      }),
    );
    expect(acceptance?.loop?.steps[1]).toEqual(
      expect.objectContaining({
        label: "Adversarial QA acceptance",
        session: { mode: "independent" },
        execution: { access: "review", isolation: "shared" },
        output: expect.objectContaining({
          kind: "json",
          schema: expect.objectContaining({
            required: expect.arrayContaining(["status", "conclusion"]),
          }),
        }),
        prompt: expect.stringMatching(
          /# 角色.*# 检查要求.*PASS 时 blockers 必须为空.*FAIL 时 blockers 必须至少包含一个可执行的阻塞项.*# 输出约束.*<context>/su,
        ),
      }),
    );

    const publish = flow.nodes.find(
      (node) => node.id === "publish_qa_approved_pr",
    );
    expect(publish).toEqual(
      expect.objectContaining({
        kind: "effect",
        file: "scripts/publish-qa-approved-pr.mjs",
        execution: { access: "write", isolation: "required" },
        inputs: expect.objectContaining({
          acceptance: expect.objectContaining({
            expression: "acceptance",
          }),
          workspace: expect.objectContaining({
            expression: "workspace",
          }),
        }),
      }),
    );
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
            "qa_not_accepted_report",
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
          targetNodeId: "rd_qa_acceptance",
        }),
        expect.objectContaining({
          sourceNodeId: "rd_qa_acceptance",
          outcome: "matched",
          targetNodeId: "publish_qa_approved_pr",
        }),
        expect.objectContaining({
          sourceNodeId: "rd_qa_acceptance",
          outcome: "exhausted",
          targetNodeId: "close_qa_not_accepted_issue",
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
    ).toContain("qa_not_accepted");
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
  "auth status") exit 0 ;;
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
      exportName: "run",
      context: {
        candidate: { path: "src/large.ts", lines: 1500 },
        preflight: preflight.value,
      },
      environment,
      projectCwd,
    });
    expect(deliveryReady.value).toEqual({
      repository: "example/project",
    });

    const labelContext = {
      deliveryReady: deliveryReady.value,
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
        candidate: { path: "src/large.ts", lines: 1500 },
        cycle: { id: "cycle-readable-issue" },
        plan: {
          title: "Extract focused modules",
          rationale: "Separate unrelated responsibilities.",
          responsibilities: ["Coordinates parsing and persistence."],
          evidence: ["src/large.ts:40 parseInput mixes parsing and storage."],
          boundaries: ["Preserve public APIs."],
          affectedFiles: ["src/large.ts", "src/parser.ts"],
          behaviorInvariants: ["Keep parseInput error semantics."],
          orderedSteps: ["Extract helpers.", "Update imports."],
          tests: ["Run focused unit tests."],
          risks: ["Import cycles."],
          unknowns: ["No integration fixture covers malformed legacy input."],
        },
        workspace: { baseCommit: "abc123" },
      },
      environment,
      projectCwd,
    });
    expect(issue.value).toEqual({
      externalRef: "https://github.com/example/project/issues/1",
      output: {
        approvalLabel: "flow-approved",
        marker: "[flow:cycle-readable-issue]",
        title: "[flow:cycle-readable-issue] Refactor src/large.ts",
        url: "https://github.com/example/project/issues/1",
      },
    });
    const issueArguments = readFileSync(issueCall, "utf8");
    expect(issueArguments).toContain("## Candidate");
    expect(issueArguments).toContain("## Analysis snapshot");
    expect(issueArguments).toContain("## Repository evidence");
    expect(issueArguments).toContain("## Behavior invariants");
    expect(issueArguments).toContain("## Plan");
    expect(issueArguments).toContain("## Validation");
    expect(issueArguments).toContain("## Unknowns");
    expect(issueArguments).toContain("abc123");
    expect(issueArguments).toContain("flow-approved");
  });

  it("publishes one pull request containing the final QA conclusion", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const root = mkdtempSync(path.join(tmpdir(), "flow-qa-publish-"));
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
      acceptance: {
        final: {
          status: "PASS",
          conclusion: "QA verified behavior preservation and focused tests.",
          criteria: ["Public behavior is preserved."],
          blockers: [],
          suggestions: [],
          risks: ["Downstream integration remains CI-covered."],
          checks: ["pnpm vitest run source.test.ts — passed"],
          evidence: ["source.ts now delegates focused responsibilities."],
          unverified: [],
        },
      },
      candidate: { path: "source.ts", lines: 1500 },
      cycle: { id: "cycle-publish", sequence: 1 },
      issue: { url: "https://github.com/example/project/issues/4" },
      mainBranch: "main",
      plan: { title: "Split source responsibilities" },
      workspace: { branch, path: projectCwd },
    };
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    const published = await runFlowV1CodeModule({
      versionId: "large-file-publish-qa-pass",
      bundle: blueprint.bundle,
      file: "scripts/publish-qa-approved-pr.mjs",
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
        qaConclusion:
          "QA verified behavior preservation and focused tests.",
      }),
    );
    expect(readFileSync(prCall, "utf8")).toContain("## QA conclusion");
    expect(readFileSync(prCall, "utf8")).toContain(
      "QA verified behavior preservation and focused tests.",
    );
    expect(git(["ls-remote", "origin", `refs/heads/${branch}`], projectCwd)).toContain(
      String(publishOutput.commit),
    );

    const reconciled = await runFlowV1CodeModule({
      versionId: "large-file-publish-qa-pass-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/publish-qa-approved-pr.mjs",
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

  it("uses collision-free worktree branches and removes terminal local state", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(path.join(tmpdir(), "flow-worktree-blueprint-"));
    temporaryDirectories.push(projectCwd);
    git(["init"], projectCwd);
    git(["config", "user.name", "Flow Test"], projectCwd);
    git(["config", "user.email", "flow@example.test"], projectCwd);
    writeFileSync(path.join(projectCwd, "source.ts"), "export const value = 1;\n");
    git(["add", "source.ts"], projectCwd);
    git(["commit", "-m", "initial"], projectCwd);
    const commit = git(["rev-parse", "HEAD"], projectCwd);
    const cycleIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const branches: string[] = [];

    for (const [index, cycleId] of cycleIds.entries()) {
      const prepared = await runFlowV1CodeModule({
        versionId: `large-file-worktree-${index}`,
        bundle: blueprint.bundle,
        file: "scripts/prepare-worktree.mjs",
        exportName: "apply",
        context: {
          cycle: { id: cycleId, sequence: 1 },
          sync: { commit },
        },
        projectCwd,
      });
      const preparedValue = prepared.value as FlowV1JsonObject;
      const output = preparedValue.output as FlowV1JsonObject;
      expect(output.baseCommit).toBe(commit);
      branches.push(String(output.branch));
    }
    expect(branches).toEqual([
      "flow/large-file-11111111-111",
      "flow/large-file-22222222-222",
    ]);

    for (const [index, cycleId] of cycleIds.entries()) {
      const cleaned = await runFlowV1CodeModule({
        versionId: `large-file-cleanup-${index}`,
        bundle: blueprint.bundle,
        file: "scripts/cleanup-worktree.mjs",
        exportName: "run",
        context: {
          cycle: { id: cycleId, sequence: 1 },
          terminal: { status: "completed" },
        },
        projectCwd,
      });
      expect(cleaned.value).toEqual(
        expect.objectContaining({
          cleaned: true,
          branch: branches[index],
        }),
      );
      expect(git(["branch", "--list", branches[index]], projectCwd)).toBe(
        "",
      );
    }
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
        plan: {
          title: "Extract focused modules",
          rationale: "A deliberately long rationale that belongs in the Issue.",
        },
        pullRequest: { url: "https://github.com/example/project/pull/2" },
      },
      projectCwd,
    });
    expect(memory.value).toEqual({
      currentUnderstanding: [
        "Last completed candidate: src/large.ts (1500 lines before refactor)",
        "Plan: Extract focused modules",
        "Issue: https://github.com/example/project/issues/1",
        "Pull request: https://github.com/example/project/pull/2",
        "Merged: true",
      ].join("\n"),
      decision:
        "Cycle cycle-1: Extract focused modules for src/large.ts",
      timeline:
        "Cycle cycle-1: merged https://github.com/example/project/pull/2",
    });
    expect(JSON.stringify(memory.value)).not.toContain("deliberately long");
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
