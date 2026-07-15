import {
  ArrowRight,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import { formatLoopUntil } from "@/lib/workflow/loop-until";
import { resolveLoopStepSessionSpec } from "@/lib/workflow/session";
import type {
  WorkflowLoopSpec,
  WorkflowLoopStep,
} from "@/lib/workflow/types";
import type { FlowNodeData } from "@/components/workflow/WorkflowWorkbench.types";

type LoopMiniFlowProps = {
  loop: NonNullable<FlowNodeData["workflowNode"]["loop"]>;
  loopNodeId: string;
  selectedStepId?: string;
  onStepSelect?: (loopNodeId: string, stepId: string) => void;
};

export function LoopMiniFlow(props: LoopMiniFlowProps) {
  const untilView = formatLoopUntil(props.loop.until);

  return (
    <div className="loop-mini-flow">
      <div aria-label="Loop step flow" className="loop-mini-flow-steps">
        {props.loop.steps.map((step, index) => {
          const isFirstIterationEntry =
            props.loop.firstIteration?.startAt === step.id;
          if (step.kind === "human") {
            return (
              <div className="loop-mini-flow-step-group" key={step.id}>
                <button
                  type="button"
                  className={
                    step.id === props.selectedStepId
                      ? "loop-mini-flow-step selected"
                      : "loop-mini-flow-step"
                  }
                  aria-label={`${index + 1} ${step.label} ${step.id} human task`}
                  title={`Inspect ${step.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onStepSelect?.(props.loopNodeId, step.id);
                  }}
                >
                  <div className="loop-mini-flow-step-title">
                    <span className="loop-mini-flow-step-index">{index + 1}</span>
                    <span className="loop-mini-flow-step-label" title={step.label}>
                      {step.label}
                    </span>
                  </div>
                  <div className="loop-mini-flow-step-session">{step.id} · waits for input</div>
                  <div className="loop-mini-flow-badges">
                    {isFirstIterationEntry ? (
                      <span className="loop-step-badge">first entry</span>
                    ) : null}
                    <span className="loop-step-badge">human</span>
                    <span className="loop-step-badge">{step.human.actions.length} actions</span>
                  </div>
                </button>
                {index < props.loop.steps.length - 1 ? (
                  <ArrowRight aria-hidden className="loop-mini-flow-arrow" size={16} strokeWidth={2.1} />
                ) : null}
              </div>
            );
          }
          const sessionView = describeLoopStepSession(props.loop, step);
          const promptModeView = describeLoopStepPromptMode(step, sessionView);
          const targetView = describeLoopStepTarget(step);
          const ariaLabel = [
            index + 1,
            step.label,
            step.id,
            sessionView.label,
            sessionView.badge,
            targetView?.label,
            promptModeView?.label,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div className="loop-mini-flow-step-group" key={step.id}>
              <button
                type="button"
                className={
                  step.id === props.selectedStepId
                    ? "loop-mini-flow-step selected"
                    : "loop-mini-flow-step"
                }
                aria-label={ariaLabel}
                title={`Edit ${step.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onStepSelect?.(props.loopNodeId, step.id);
                }}
              >
                <div className="loop-mini-flow-step-title">
                  <span className="loop-mini-flow-step-index">{index + 1}</span>
                  <span className="loop-mini-flow-step-label" title={step.label}>
                    {step.label}
                  </span>
                </div>
                <div
                  className="loop-mini-flow-step-session"
                  title={`${step.id} · ${sessionView.title}`}
                >
                  {step.id} · {sessionView.label}
                </div>
                <div className="loop-mini-flow-badges">
                  {isFirstIterationEntry ? (
                    <span className="loop-step-badge">first entry</span>
                  ) : null}
                  <span className="loop-step-badge">{sessionView.badge}</span>
                  {targetView ? (
                    <span className="loop-step-badge" title={targetView.title}>
                      {targetView.label}
                    </span>
                  ) : null}
                  {promptModeView ? (
                    <span className="loop-step-badge" title={promptModeView.title}>
                      {promptModeView.label}
                    </span>
                  ) : null}
                </div>
              </button>
              {index < props.loop.steps.length - 1 ? (
                <ArrowRight
                  aria-hidden
                  className="loop-mini-flow-arrow"
                  size={16}
                  strokeWidth={2.1}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="loop-mini-flow-footer">
        {props.loop.firstIteration ? (
          <div
            className="loop-mini-flow-until"
            title={`The first iteration starts at ${props.loop.firstIteration.startAt}; later iterations run every step.`}
          >
            <ArrowRight aria-hidden size={13} strokeWidth={2.2} />
            <span>first starts at {props.loop.firstIteration.startAt}</span>
          </div>
        ) : null}
        <div
          className="loop-mini-flow-until"
          title={untilView}
        >
          <RotateCcw aria-hidden size={13} strokeWidth={2.2} />
          <span>repeat until {untilView}</span>
        </div>
        <div
          className="loop-mini-flow-exit"
          title={`Exit when ${untilView}, max ${props.loop.maxIterations} iterations`}
        >
          <CheckCircle2 aria-hidden size={13} strokeWidth={2.2} />
          exit / max {props.loop.maxIterations}
        </div>
      </div>
    </div>
  );
}

function describeLoopStepSession(
  loop: WorkflowLoopSpec,
  step: WorkflowLoopStep,
): {
  label: string;
  title: string;
  badge: string;
  inherits: boolean;
} {
  const session = resolveLoopStepSessionSpec({
    loopSession: loop.session,
    stepSession: step.session,
    stepId: step.id,
  });
  if (!session || session.mode === "independent") {
    return {
      label: "new session",
      title: "Starts an independent agent session each time",
      badge: "independent",
      inherits: false,
    };
  }
  return {
    label: session.key,
    title: `Reuses workflow session ${session.key} across loop iterations`,
    badge: "reuse session",
    inherits: true,
  };
}

function describeLoopStepPromptMode(
  step: WorkflowLoopStep,
  sessionView: { inherits: boolean },
): { label: string; title: string } | undefined {
  if (!sessionView.inherits) {
    return undefined;
  }
  if (step.appendPrompt) {
    return {
      label: "appendPrompt",
      title:
        "First iteration sends the full prompt; later iterations reuse the session and send appendPrompt.",
    };
  }
  return {
    label: "full prompt",
    title:
      "Every iteration reuses the same session but sends this step's full prompt.",
  };
}

function describeLoopStepTarget(
  step: WorkflowLoopStep,
): { label: string; title: string } | undefined {
  if (!step.agent && !step.model) {
    return undefined;
  }
  const label = [step.agent ?? "run default", step.model]
    .filter(Boolean)
    .join(" / ");
  return {
    label,
    title: `Uses ${label} for this loop step`,
  };
}
