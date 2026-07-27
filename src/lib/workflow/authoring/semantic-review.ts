import { createHash, randomUUID } from "node:crypto";
import {
  cancelAgentRun,
  getAgentSessionConversation,
  listAgentTargets,
  runAgent,
} from "@/lib/agents/runtime";
import type { AgentConversationMessage } from "@/lib/agents/types";
import {
  compareAndSetAuthoringSemanticReview,
  getAuthoringSemanticReview,
  setAuthoringSemanticReview,
} from "@/lib/db/workflows/semantic-reviews";
import { getWorkflowGeneration } from "@/lib/db/workflows/generations";
import type {
  AuthoringSemanticReview,
  AuthoringSemanticReviewFinding,
} from "@/lib/db/workflows/types";
import { prepareSemanticReviewWorkspace } from "./workspace";

type ReviewJob = {
  jobId: string;
  agent: string;
  model?: string;
  cwd: string;
  authorSessionId: string;
  fallbackIntent: string;
};

type ReviewOutput = {
  verdict: "pass" | "fail";
  summary: string;
  findings: AuthoringSemanticReviewFinding[];
};

type ActiveReview = {
  reviewId: string;
  controller: AbortController;
  promise?: Promise<void>;
};

const activeReviews = new Map<string, ActiveReview>();
const reviewStartLocks = new Map<string, Promise<void>>();

export function startAuthoringSemanticReview(input: {
  jobId: string;
  script: string;
  reviewerAgent?: string;
  reviewerModel?: string;
}): Promise<AuthoringSemanticReview> {
  const previous = reviewStartLocks.get(input.jobId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => startAuthoringSemanticReviewLocked(input));
  const lock = operation.then(
    () => undefined,
    () => undefined,
  );
  reviewStartLocks.set(input.jobId, lock);
  void lock.finally(() => {
    if (reviewStartLocks.get(input.jobId) === lock) {
      reviewStartLocks.delete(input.jobId);
    }
  });
  return operation;
}

async function startAuthoringSemanticReviewLocked(input: {
  jobId: string;
  script: string;
  reviewerAgent?: string;
  reviewerModel?: string;
}): Promise<AuthoringSemanticReview> {
  const authorJob = resolveReviewJob(input.jobId);
  const job: ReviewJob = {
    ...authorJob,
    agent: input.reviewerAgent?.trim() || authorJob.agent,
    model: input.reviewerModel?.trim() || authorJob.model,
  };
  const scriptHash = hashAuthoringScript(input.script);
  const existing = getAuthoringSemanticReview(job.jobId);
  const existingActive = activeReviews.get(job.jobId);

  let conversation: AgentConversationMessage[];
  try {
    conversation = await readIntentConversation(job.authorSessionId);
  } catch (error) {
    const unavailable = createUnavailableReview({
      job,
      scriptHash,
      error:
        error instanceof Error ? error.message : "Conversation unavailable.",
    });
    setAuthoringSemanticReview(job.jobId, unavailable);
    return unavailable;
  }
  const intentHash = hashIntentConversation(conversation);

  if (
    existing?.status === "running" &&
    existing.scriptHash === scriptHash &&
    existing.intentHash === intentHash &&
    existing.reviewerAgent === job.agent &&
    existing.reviewerModel === (job.model ?? null) &&
    existingActive?.reviewId === existing.reviewId
  ) {
    return existing;
  }

  if (existingActive) {
    existingActive.controller.abort();
    try {
      await cancelAgentRun(`authoring-review:${existingActive.reviewId}`);
    } catch {
      // The abort signal is authoritative; a best-effort runtime cancel may
      // race with a session that has already reached its stop point.
    }
  }

  const now = new Date().toISOString();
  const review: AuthoringSemanticReview = {
    reviewId: randomUUID(),
    status: "running",
    intentHash,
    scriptHash,
    reviewerAgent: job.agent,
    reviewerModel: job.model ?? null,
    reviewerSessionId: null,
    summary: "Semantic review is running.",
    findings: [],
    startedAt: now,
    completedAt: null,
  };
  job.cwd = prepareSemanticReviewWorkspace({
    jobId: job.jobId,
    reviewId: review.reviewId,
  });
  setAuthoringSemanticReview(job.jobId, review);

  const controller = new AbortController();
  const active: ActiveReview = {
    reviewId: review.reviewId,
    controller,
  };
  activeReviews.set(job.jobId, active);

  const promise = executeReview({
    job,
    review,
    conversation,
    script: input.script,
    signal: controller.signal,
  })
    .catch((error) => {
      finishReview(job.jobId, review, {
        status: "unavailable",
        summary: "Semantic review could not be completed.",
        error: error instanceof Error ? error.message : "Unknown reviewer error.",
      });
    })
    .finally(() => {
      if (activeReviews.get(job.jobId) === active) {
        activeReviews.delete(job.jobId);
      }
    });
  active.promise = promise;
  return review;
}

export function getCurrentAuthoringSemanticReview(
  jobId: string,
): AuthoringSemanticReview | null {
  return getAuthoringSemanticReview(jobId);
}

export async function waitForAuthoringSemanticReview(
  jobId: string,
): Promise<AuthoringSemanticReview | null> {
  await activeReviews.get(jobId)?.promise;
  return refreshAuthoringSemanticReview(jobId);
}

export async function refreshAuthoringSemanticReview(
  jobId: string,
): Promise<AuthoringSemanticReview | null> {
  const review = getAuthoringSemanticReview(jobId);
  if (!review || review.status === "waived" || review.status === "stale") {
    return review;
  }
  if (
    review.status === "running" &&
    activeReviews.get(jobId)?.reviewId !== review.reviewId
  ) {
    return markReviewUnavailable(
      jobId,
      review,
      "The review coordinator restarted or lost the reviewer execution handle. Start the review again.",
    );
  }
  try {
    const intentHash = await getCurrentIntentHash(jobId);
    return review.intentHash === intentHash
      ? review
      : markReviewStale(jobId, review);
  } catch {
    return review;
  }
}

export async function getCurrentIntentHash(jobId: string): Promise<string> {
  const job = resolveReviewJob(jobId);
  return hashIntentConversation(
    await readIntentConversation(job.authorSessionId),
  );
}

export function hashAuthoringScript(script: string): string {
  return sha256(script);
}

export function hashIntentConversation(
  conversation: AgentConversationMessage[],
): string {
  return sha256(
    JSON.stringify(
      conversation.map(({ role, text }) => ({ role, text })),
    ),
  );
}

export function markReviewStale(
  jobId: string,
  review: AuthoringSemanticReview,
): AuthoringSemanticReview {
  if (review.status === "stale") {
    return review;
  }
  const stale: AuthoringSemanticReview = {
    ...review,
    status: "stale",
    summary: "The user intent or workflow script changed after this review.",
    completedAt: new Date().toISOString(),
  };
  const updated = compareAndSetAuthoringSemanticReview({
    jobId,
    reviewId: review.reviewId,
    expectedStatus: review.status,
    review: stale,
  });
  return updated ? stale : getAuthoringSemanticReview(jobId) ?? stale;
}

export function createWaivedSemanticReview(input: {
  intentHash: string;
  scriptHash: string;
  reason: string;
}): AuthoringSemanticReview {
  const now = new Date().toISOString();
  return {
    reviewId: randomUUID(),
    status: "waived",
    intentHash: input.intentHash,
    scriptHash: input.scriptHash,
    reviewerAgent: null,
    reviewerModel: null,
    reviewerSessionId: null,
    summary: "Semantic review was explicitly waived.",
    findings: [],
    waiverReason: input.reason,
    startedAt: now,
    completedAt: now,
  };
}

async function executeReview(input: {
  job: ReviewJob;
  review: AuthoringSemanticReview;
  conversation: AgentConversationMessage[];
  script: string;
  signal: AbortSignal;
}): Promise<void> {
  let text = "";
  let reviewerSessionId: string | null = null;
  let terminal: "completed" | "failed" | "canceled" = "failed";
  let runtimeError = "";
  const permissionMode = await resolveReadOnlyPermissionMode(input.job.agent);

  for await (const event of runAgent({
    runId: `authoring-review:${input.review.reviewId}`,
    agent: input.job.agent,
    model: input.job.model,
    cwd: input.job.cwd,
    permissionMode,
    title: "Workflow design review",
    prompt: buildReviewPrompt(
      input.conversation,
      input.script,
    ),
    signal: input.signal,
  })) {
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "session_ref") {
      reviewerSessionId = event.session.agentSessionId;
      compareAndSetAuthoringSemanticReview({
        jobId: input.job.jobId,
        reviewId: input.review.reviewId,
        expectedStatus: "running",
        review: { ...input.review, reviewerSessionId },
      });
    } else if (event.type === "error") {
      runtimeError = event.message;
    } else if (event.type === "done") {
      terminal = event.status ?? "completed";
    }
  }

  const base = { reviewerSessionId };
  if (terminal === "canceled") {
    finishReview(input.job.jobId, input.review, {
      ...base,
      status: "canceled",
      summary: "Semantic review was canceled.",
    });
    return;
  }
  if (terminal !== "completed") {
    finishReview(input.job.jobId, input.review, {
      ...base,
      status: "unavailable",
      summary: "Semantic reviewer failed before returning a verdict.",
      error: runtimeError || "Reviewer session failed.",
    });
    return;
  }

  const output = parseReviewOutput(text);
  if (!output) {
    finishReview(input.job.jobId, input.review, {
      ...base,
      status: "invalid_output",
      summary: "Semantic reviewer returned an invalid result.",
      error: "Expected one JSON object with verdict, summary, and findings.",
    });
    return;
  }
  finishReview(input.job.jobId, input.review, {
    ...base,
    status: output.verdict === "pass" ? "passed" : "failed",
    summary: output.summary,
    findings: output.findings,
  });
}

function createUnavailableReview(input: {
  job: ReviewJob;
  scriptHash: string;
  error: string;
}): AuthoringSemanticReview {
  const now = new Date().toISOString();
  return {
    reviewId: randomUUID(),
    status: "unavailable",
    intentHash: hashIntentConversation([
      { role: "user", text: input.job.fallbackIntent },
    ]),
    scriptHash: input.scriptHash,
    reviewerAgent: input.job.agent,
    reviewerModel: input.job.model ?? null,
    reviewerSessionId: null,
    summary: "Authoring conversation could not be read for semantic review.",
    findings: [],
    error: input.error,
    startedAt: now,
    completedAt: now,
  };
}

function markReviewUnavailable(
  jobId: string,
  review: AuthoringSemanticReview,
  error: string,
): AuthoringSemanticReview {
  const unavailable: AuthoringSemanticReview = {
    ...review,
    status: "unavailable",
    summary: "Semantic review execution is no longer active.",
    error,
    completedAt: new Date().toISOString(),
  };
  const updated = compareAndSetAuthoringSemanticReview({
    jobId,
    reviewId: review.reviewId,
    expectedStatus: "running",
    review: unavailable,
  });
  return updated
    ? unavailable
    : getAuthoringSemanticReview(jobId) ?? unavailable;
}

function finishReview(
  jobId: string,
  running: AuthoringSemanticReview,
  patch: Partial<AuthoringSemanticReview> & {
    status: AuthoringSemanticReview["status"];
    summary: string;
  },
): void {
  compareAndSetAuthoringSemanticReview({
    jobId,
    reviewId: running.reviewId,
    expectedStatus: "running",
    review: {
      ...running,
      ...patch,
      completedAt: new Date().toISOString(),
    },
  });
}

function resolveReviewJob(jobId: string): ReviewJob {
  const generation = getWorkflowGeneration(jobId);
  if (!generation) {
    throw new Error("Authoring job not found.");
  }
  if (!generation.agent || !generation.agentSessionId) {
    throw new Error("Authoring agent session is unavailable.");
  }
  return {
    jobId,
    agent: generation.agent,
    model: generation.model ?? undefined,
    cwd: "",
    authorSessionId: generation.agentSessionId,
    fallbackIntent: generation.prompt,
  };
}

async function readIntentConversation(
  sessionId: string,
): Promise<AgentConversationMessage[]> {
  const conversation = await getAgentSessionConversation(sessionId);
  let latestUser = -1;
  for (let index = 0; index < conversation.length; index += 1) {
    if (conversation[index].role === "user") {
      latestUser = index;
    }
  }
  if (latestUser < 0) {
    throw new Error("Authoring conversation contains no user message.");
  }
  return conversation.slice(0, latestUser + 1);
}

async function resolveReadOnlyPermissionMode(
  agent: string,
): Promise<string | undefined> {
  const target = (await listAgentTargets()).find((item) => item.id === agent);
  return target?.permissionModes?.find((mode) => {
    const key = `${mode.id} ${mode.semantic ?? ""}`.toLowerCase();
    return key.includes("read-only") || key.includes("readonly");
  })?.id;
}

function buildReviewPrompt(
  conversation: AgentConversationMessage[],
  script: string,
): string {
  return [
    "请根据用户明确表达的目标审查这个持久化 Flow Bundle。",
    "不要编辑文件、运行 Flow、修复 Bundle 或提出问题。",
    "待审查内容是一个 tutti.flow.v1 Bundle，以按路径分隔的源文件形式呈现。",
    "检查 Cycle/Tick 边界、Schedule 行为、单例推进、数据与控制可达性、Script 与 Effect 的副作用边界、Gate/Human 等待点、终态后的继续方式、有界 Loop/Map 行为、Finally 覆盖、Memory 使用、Params/Inputs/Secrets 边界，以及幂等性和恢复行为。",
    "如果周期性调度可能重复产生副作用、等待条件无法在 Tick 之间变化、缺少终态路径，或必要值无法到达使用它的节点，则判定失败。",
    "只有所有检查都闭合时才能 PASS；任何不确定性都应作为失败，并给出具体发现。",
    "仅返回 JSON：{\"verdict\":\"pass|fail\",\"summary\":\"...\",\"findings\":[{\"reason\":\"...\",\"nodePath\":[\"按顺序排列的节点 ID\"],\"suggestion\":\"...\"}]}",
    "仅在 pass 时使用空 findings 数组。",
    "",
    "截至最新用户消息的可见编写对话：",
    JSON.stringify(conversation.map(({ role, text }) => ({ role, text }))),
    "",
    "当前 FLOW BUNDLE：",
    script,
  ].join("\n");
}

function parseReviewOutput(text: string): ReviewOutput | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let value: unknown;
  try {
    value = JSON.parse(candidate.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.verdict !== "pass" && record.verdict !== "fail") ||
    typeof record.summary !== "string" ||
    !Array.isArray(record.findings)
  ) {
    return null;
  }
  const findings = record.findings.flatMap(
    (finding): AuthoringSemanticReviewFinding[] => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        return [];
      }
      const item = finding as Record<string, unknown>;
      if (
        typeof item.reason !== "string" ||
        !Array.isArray(item.nodePath) ||
        !item.nodePath.every((node) => typeof node === "string") ||
        typeof item.suggestion !== "string"
      ) {
        return [];
      }
      return [{
        reason: item.reason,
        nodePath: item.nodePath as string[],
        suggestion: item.suggestion,
      }];
    },
  );
  if (findings.length !== record.findings.length) {
    return null;
  }
  if (record.verdict === "pass" && findings.length > 0) {
    return null;
  }
  if (record.verdict === "fail" && findings.length === 0) {
    return null;
  }
  return { verdict: record.verdict, summary: record.summary, findings };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
