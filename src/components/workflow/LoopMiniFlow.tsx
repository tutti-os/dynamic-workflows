import {
  ArrowRight,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
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
  return (
    <div className="loop-mini-flow">
      <div aria-label="Loop step flow" className="loop-mini-flow-steps">
        {props.loop.steps.map((step, index) => {
          const sessionView = describeLoopStepSession(props.loop, step);
          const promptModeView = describeLoopStepPromptMode(step, sessionView);
          return (
            <div className="loop-mini-flow-step-group" key={step.id}>
              <button
                type="button"
                className={
                  step.id === props.selectedStepId
                    ? "loop-mini-flow-step selected"
                    : "loop-mini-flow-step"
                }
                aria-label={`${index + 1} ${step.label} ${step.id} · ${sessionView.label} ${sessionView.badge}${promptModeView ? ` ${promptModeView.label}` : ""}`}
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
                  <span className="loop-step-badge">{sessionView.badge}</span>
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
        <div
          className="loop-mini-flow-until"
          title={`${props.loop.until.source} includes ${JSON.stringify(
            props.loop.until.includes,
          )}`}
        >
          <RotateCcw aria-hidden size={13} strokeWidth={2.2} />
          <span>
            repeat while {props.loop.until.source} misses{" "}
            {JSON.stringify(props.loop.until.includes)}
          </span>
        </div>
        <div
          className="loop-mini-flow-exit"
          title={`Exit when ${props.loop.until.source} includes ${JSON.stringify(
            props.loop.until.includes,
          )}, max ${props.loop.maxIterations} iterations`}
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
