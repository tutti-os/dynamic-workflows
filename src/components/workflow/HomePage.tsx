"use client";

import { Separator, TuttiMark } from "@tutti-os/ui-system";
import { CreateWorkflowPanel } from "@/components/workflow/CreateWorkflowPanel";
import { ImportWorkflowDialog } from "@/components/workflow/ImportWorkflowPanel";
import { useWorkflowHomeController } from "@/components/workflow/useWorkflowHomeController";
import { useWorkflowRunSettings } from "@/components/workflow/useWorkflowRunSettings";
import { WorkflowGrid } from "@/components/workflow/WorkflowGrid";
import { WorkflowIndexToolbar } from "@/components/workflow/WorkflowIndexToolbar";

export function HomePage() {
  const {
    providers,
    effectiveProvider,
    model,
    modelOptions,
    cwd,
    setProvider,
    setModel,
    setCwd,
  } = useWorkflowRunSettings();
  const {
    prompt,
    setPrompt,
    workflows,
    filteredWorkflows,
    workflowCount,
    runCount,
    query,
    setQuery,
    statusFilter,
    setStatusFilter,
    isCreating,
    createError,
    createDiagnostics,
    createWorkflow,
    importScript,
    setImportScript,
    isImporting,
    importError,
    importDiagnostics,
    importWorkflow,
    duplicatingId,
    deletingId,
    actionError,
    duplicateWorkflow,
    deleteWorkflow,
  } = useWorkflowHomeController({
    effectiveProvider,
    model,
    cwd,
  });

  return (
    <main className="home-shell">
      <header className="home-topbar">
        <div className="app-brand">
          <span className="app-brand-mark">
            <TuttiMark size={28} />
          </span>
          <span className="app-brand-title">Dynamic Workflows</span>
        </div>
      </header>

      <section className="home-hero">
        <div className="hero-copy">
          <h1>Create a workflow from a prompt</h1>
          <p>
            Describe what you want to automate. We'll generate a workflow script
            and you can run it locally with your agents.
          </p>
        </div>

        <CreateWorkflowPanel
          prompt={prompt}
          providers={providers}
          provider={effectiveProvider}
          model={model}
          modelOptions={modelOptions}
          cwd={cwd}
          isCreating={isCreating}
          createError={createError}
          createDiagnostics={createDiagnostics}
          onPromptChange={setPrompt}
          onProviderChange={setProvider}
          onModelChange={setModel}
          onCwdChange={setCwd}
          onCreate={createWorkflow}
        />
      </section>

      <section className="workflow-index">
        <div className="ornament-divider" aria-hidden="true">
          <Separator />
          <TuttiMark size={18} />
          <Separator />
        </div>
        <div className="section-heading">
          <div className="section-heading-main">
            <h2>Recent workflows</h2>
            <p>
              {filteredWorkflows.length} of {workflowCount} workflows ·{" "}
              {runCount} runs
            </p>
          </div>
          <div className="section-heading-actions">
            <ImportWorkflowDialog
              script={importScript}
              isImporting={isImporting}
              importError={importError}
              importDiagnostics={importDiagnostics}
              onScriptChange={setImportScript}
              onImport={importWorkflow}
            />
          </div>
        </div>
        <WorkflowIndexToolbar
          query={query}
          statusFilter={statusFilter}
          onQueryChange={setQuery}
          onStatusFilterChange={setStatusFilter}
        />
        {actionError ? <div className="diagnostic error">{actionError}</div> : null}
        <WorkflowGrid
          workflows={filteredWorkflows}
          hasAnyWorkflow={workflows.length > 0}
          duplicatingId={duplicatingId}
          deletingId={deletingId}
          onDuplicateWorkflow={duplicateWorkflow}
          onDeleteWorkflow={deleteWorkflow}
        />
        <p className="local-note">Workflows are stored locally on your machine.</p>
      </section>
    </main>
  );
}
