import {
  Badge,
  Input,
  TaskIcon,
  Textarea,
} from "@tutti-os/ui-system";
import type { WorkflowNode } from "@/lib/workflow/types";

type EditPanelProps = {
  selectedNode?: WorkflowNode;
  labelDraft: string;
  promptDraft: string;
  nodeOutputs: Record<string, string>;
  latestOutput?: [string, string];
  eventLog: string[];
  onLabelChange: (value: string) => void;
  onPromptChange: (value: string) => void;
};

export function EditPanel(props: EditPanelProps) {
  const selectedNode = props.selectedNode;

  return (
    <div className="edit-panel">
      {selectedNode ? (
        <>
          <div className="field">
            <label htmlFor="node-label">Label</label>
            <Input
              id="node-label"
              value={props.labelDraft}
              disabled={!selectedNode.labelRange}
              onChange={(event) => props.onLabelChange(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="node-prompt">Prompt</label>
            <Textarea
              id="node-prompt"
              rows={8}
              value={props.promptDraft}
              disabled={!selectedNode.promptRange}
              onChange={(event) => props.onPromptChange(event.target.value)}
            />
          </div>

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
