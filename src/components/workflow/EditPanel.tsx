import {
  Badge,
  Button,
  Input,
  TaskIcon,
  Textarea,
} from "@tutti-os/ui-system";
import type { WorkflowLoopStep, WorkflowNode } from "@/lib/workflow/types";

type EditPanelProps = {
  selectedNode?: WorkflowNode;
  selectedLoopStepId?: string;
  labelDraft: string;
  promptDraft: string;
  appendPromptDraft: string;
  nodeOutputs: Record<string, string>;
  latestOutput?: [string, string];
  eventLog: string[];
  onLabelChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onAppendPromptChange: (value: string) => void;
  onSelectLoopStep: (stepId: string | undefined) => void;
};

export function EditPanel(props: EditPanelProps) {
  const selectedNode = props.selectedNode;
  const selectedLoopStep = selectedNode?.loop?.steps.find(
    (step) => step.id === props.selectedLoopStepId,
  );
  const editTarget = selectedLoopStep ?? selectedNode;

  return (
    <div className="edit-panel">
      {selectedNode ? (
        <>
          <div className="field">
            <label htmlFor="node-label">
              {selectedLoopStep ? "Step label" : "Label"}
            </label>
            <Input
              id="node-label"
              value={props.labelDraft}
              disabled={!editTarget?.labelRange}
              onChange={(event) => props.onLabelChange(event.target.value)}
            />
          </div>

          {selectedNode.loop ? (
            <div className="field">
              <label>Loop steps</label>
              <div className="loop-step-picker">
                {selectedNode.loop.steps.map((step) => (
                  <Button
                    key={step.id}
                    type="button"
                    size="sm"
                    variant={
                      step.id === selectedLoopStep?.id ? "default" : "outline"
                    }
                    onClick={() => props.onSelectLoopStep(step.id)}
                  >
                    {step.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="node-prompt">
              {selectedLoopStep ? "Step prompt" : "Prompt"}
            </label>
            <Textarea
              id="node-prompt"
              rows={8}
              value={props.promptDraft}
              disabled={!editTarget?.promptRange}
              onChange={(event) => props.onPromptChange(event.target.value)}
            />
          </div>

          {selectedLoopStep ? (
            <div className="field">
              <label htmlFor="node-append-prompt">Append prompt</label>
              {selectedLoopStep.appendPromptRange ? (
                <Textarea
                  id="node-append-prompt"
                  rows={6}
                  value={props.appendPromptDraft}
                  onChange={(event) =>
                    props.onAppendPromptChange(event.target.value)
                  }
                />
              ) : (
                <div className="field-hint">
                  This step has no appendPrompt field in the script.
                </div>
              )}
            </div>
          ) : null}

          <div className="field">
            <label>Inputs</label>
            <div className="node-refs">
              {selectedNode.inputs.length > 0 ? (
                selectedNode.inputs.map((input) => (
                  <Badge variant="default" key={input.name}>
                    {input.name} ← {input.sourceVariable}
                  </Badge>
                ))
              ) : (
                <Badge variant="muted">none</Badge>
              )}
            </div>
          </div>

          {props.nodeOutputs[selectedNode.id] ? (
            <div className="field">
              <label>Output</label>
              <pre className="output-box">{props.nodeOutputs[selectedNode.id]}</pre>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="empty-state">
            <TaskIcon size={22} />
            <p>Select a node to edit label, prompt, and inspect output.</p>
          </div>
          {props.latestOutput ? (
            <div className="field">
              <label>Latest Output: {props.latestOutput[0]}</label>
              <pre className="output-box">{props.latestOutput[1]}</pre>
            </div>
          ) : null}
        </>
      )}

      <div className="field">
        <label>Event Log</label>
        <pre className="event-log">
          {props.eventLog.length > 0
            ? props.eventLog.join("\n")
            : "No run events yet."}
        </pre>
      </div>
    </div>
  );
}
