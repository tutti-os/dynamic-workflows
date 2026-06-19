"use client";

import dynamic from "next/dynamic";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import clsx from "clsx";
import {
  StatusDot,
  UnderlineTabs,
} from "@tutti-os/ui-system";
import type { ParsedWorkflow } from "@/lib/workflow/types";
import type { RunDetail } from "@/lib/workflow/run-detail";
import {
  type FlowNodeData,
  type MainView,
} from "@/components/workflow/WorkflowWorkbench.types";
import { NODE_TYPES } from "@/components/workflow/WorkflowGraphNode";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <textarea
      className="editor-fallback"
      aria-label="Loading workflow editor"
      readOnly
      value="Loading editor..."
    />
  ),
});

type WorkflowPreviewPaneProps = {
  mainView: MainView;
  isRunPreview: boolean;
  selectedRun: RunDetail | null;
  graphParsed: ParsedWorkflow;
  flowNodes: Node<FlowNodeData>[];
  flowEdges: Edge[];
  script: string;
  hasParseErrors: boolean;
  diagnosticErrorCount: number;
  diagnosticWarningCount: number;
  onMainViewChange: (view: MainView) => void;
  onScriptChange: (script: string) => void;
  onFlowInit: (instance: ReactFlowInstance<Node<FlowNodeData>, Edge>) => void;
  onNodeSelect: (nodeId: string) => void;
};

export function WorkflowPreviewPane(props: WorkflowPreviewPaneProps) {
  return (
    <section className="pane main-preview-pane">
      <div className="pane-header main-preview-header">
        <div className="pane-title">
          <h2>
            {props.mainView === "graph"
              ? props.isRunPreview
                ? "Run Preview"
                : "DAG Preview"
              : "Workflow Script"}
          </h2>
          <p>
            {props.mainView === "graph"
              ? props.isRunPreview && props.selectedRun
                ? `${props.selectedRun.run.id} · ${props.graphParsed.nodes.length} nodes, ${props.graphParsed.edges.length} edges`
                : `${props.graphParsed.nodes.length} nodes, ${props.graphParsed.edges.length} edges across ${props.graphParsed.phases.length} phases`
              : "Each save creates a new version."}
          </p>
        </div>
        <div className="main-preview-actions">
          <UnderlineTabs
            ariaLabel="Workflow preview view"
            value={props.mainView}
            onValueChange={(value) => {
              if (value !== "graph" && value !== "script") {
                return;
              }
              props.onMainViewChange(value);
            }}
            tabs={[
              { value: "graph", label: "DAG" },
              { value: "script", label: "Code" },
            ]}
            className="main-preview-tabs"
          />
        </div>
      </div>

      {props.mainView === "script" ? (
        <>
          <div className="editor-wrap">
            <MonacoEditor
              height="100%"
              language="typescript"
              value={props.script}
              theme="vs"
              beforeMount={(monaco) => {
                monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
                  noSemanticValidation: true,
                });
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                padding: { top: 12, bottom: 12 },
                tabSize: 2,
              }}
              onChange={(value) => props.onScriptChange(value ?? "")}
            />
          </div>
          <div className="editor-statusbar">
            <span>TypeScript</span>
            <span>Spaces: 2</span>
            <span
              className={clsx(
                props.hasParseErrors
                  ? "status-error"
                  : props.diagnosticWarningCount > 0
                    ? "status-warning"
                    : "status-ok",
              )}
            >
              <StatusDot
                tone={
                  props.hasParseErrors
                    ? "red"
                    : props.diagnosticWarningCount > 0
                      ? "amber"
                      : "green"
                }
              />
              {props.hasParseErrors
                ? `${props.diagnosticErrorCount || 1} error`
                : props.diagnosticWarningCount > 0
                  ? `${props.diagnosticWarningCount} warning`
                  : "No errors"}
            </span>
          </div>
        </>
      ) : (
        <div className="graph-wrap">
          <ReactFlow
            nodes={props.flowNodes}
            edges={props.flowEdges}
            nodeTypes={NODE_TYPES}
            fitView
            minZoom={0.35}
            maxZoom={1.4}
            onInit={(instance) => {
              props.onFlowInit(instance);
              window.requestAnimationFrame(() => {
                void instance.fitView({ padding: 0.22 });
              });
            }}
            onNodeClick={(_event, node) => props.onNodeSelect(node.id)}
          >
            <Background color="var(--border-1)" gap={24} />
            <Controls />
          </ReactFlow>
        </div>
      )}
    </section>
  );
}
