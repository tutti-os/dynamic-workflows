"use client";

import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { Button } from "@tutti-os/ui-system";
import { ErrorState } from "@/components/workflow/WorkflowStates";

type WorkflowErrorBoundaryState = {
  error?: Error;
};

export class WorkflowErrorBoundary extends Component<
  { children: ReactNode },
  WorkflowErrorBoundaryState
> {
  state: WorkflowErrorBoundaryState = {};

  private reset = () => {
    this.setState({ error: undefined });
  };

  static getDerivedStateFromError(error: Error): WorkflowErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Workflow workbench failed", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-shell">
          <ErrorState
            fullPage
            title="Workflow panel crashed"
            message={this.state.error.message || "Reload the page to recover."}
            action={
              <Button type="button" onClick={this.reset}>
                重试
              </Button>
            }
          />
        </main>
      );
    }

    return this.props.children;
  }
}
