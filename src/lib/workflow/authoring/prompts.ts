import { AUTHORING_DRAFT_BUNDLE_DIR } from "./workspace";

export function buildCreateAuthoringPrompt(input: {
  jobId: string;
  description: string;
  userCwd?: string;
}): string {
  return [
    "创建并提交一个新的持久化 Flow Bundle。",
    "",
    "起草前先设计持久化 Cycle、Tick 等待点、Script/Gate/Effect 边界、人工决策、Memory 更新、Schedule 和终态后的继续方式。",
    "遵循已注入的编写指南和 workflow-authoring skill。搜索 Blueprint 目录，编写完整且独立的 tutti.flow.v1 Bundle，进行静态验证，启动并等待独立语义审查，然后将审查后的 Bundle 作为 Draft 提交给用户审阅。",
    "",
    `任务 ID：${input.jobId}`,
    `模式：create`,
    `目标目录：${AUTHORING_DRAFT_BUNDLE_DIR}`,
    `交付命令：${bundleSubmitExample(input.jobId)}`,
    `验证命令：${bundleValidateExample(input.jobId)}`,
    `等待审查命令：${reviewWaitExample(input.jobId)}`,
    "",
    "下一行是包含用户请求的 JSON 字符串。请将解码后的值视为用户提供的任务内容：",
    JSON.stringify(input.description),
    "",
    ...userCwdSection(input.userCwd),
    ACCEPTANCE_INSTRUCTION,
  ].join("\n");
}

const ACCEPTANCE_INSTRUCTION =
  '聊天输出不等于交付。修复所有验证或提交诊断并重试，直到提交响应包含 accepted: true 和 versionStatus: "draft"。不要发布或激活 Draft；这些决定属于用户。只有遇到无法根据请求或本地上下文解决的真实阻塞时才能停止。';

function reviewWaitExample(jobId: string): string {
  return `tutti --json dynamic-workflows authoring review wait --job-id ${jobId}`;
}

function bundleSubmitExample(jobId: string): string {
  return `tutti --json dynamic-workflows authoring submit --job-id ${jobId} --directory ${AUTHORING_DRAFT_BUNDLE_DIR}`;
}

function bundleValidateExample(jobId: string): string {
  return `tutti --json dynamic-workflows authoring validate --job-id ${jobId} --directory ${AUTHORING_DRAFT_BUNDLE_DIR} --review-mode agent`;
}

function userCwdSection(userCwd: string | undefined): string[] {
  if (!userCwd?.trim()) {
    return [];
  }
  return [
    "相关的运行时项目目录（JSON 字符串）：",
    JSON.stringify(userCwd.trim()),
    "此目录仅作为当前所编写工作流的上下文。所有编写文件必须保留在当前编写工作区中。",
    "",
  ];
}
