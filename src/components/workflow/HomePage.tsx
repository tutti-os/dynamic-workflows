"use client";

import { DashboardIcon, TuttiMark } from "@tutti-os/ui-system";
import { CreateWorkflowPanel } from "@/components/workflow/CreateWorkflowPanel";
import { ImportWorkflowDialog } from "@/components/workflow/ImportWorkflowPanel";
import { useWorkflowHomeController } from "@/components/workflow/useWorkflowHomeController";
import { useWorkflowRunSettings } from "@/components/workflow/useWorkflowRunSettings";
import { WorkflowGrid } from "@/components/workflow/WorkflowGrid";
import { WorkflowIndexToolbar } from "@/components/workflow/WorkflowIndexToolbar";
import { WorkflowBlueprintLibrary } from "@/components/workflow/WorkflowBlueprintLibrary";

export function HomePage() {
  const {
    agents,
    effectiveAgent,
    model,
    modelOptions,
    cwd,
    agentsLoading,
    agentsError,
    agentsWarning,
    retryAgents,
    setAgent,
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
    isLoadingWorkflows,
    isCreating,
    createError,
    createDiagnostics,
    createWorkflow,
    importFile,
    setImportFile,
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
    effectiveAgent,
    model,
    cwd,
  });

  return (
    <main className="home-shell">
      <header className="home-topbar">
        <div className="home-topbar-inner">
          <div className="app-brand">
            <span className="app-brand-mark">
              <TuttiMark size={28} />
            </span>
            <span className="app-brand-title">Dynamic Workflows</span>
          </div>
          <nav className="home-nav" aria-label="Primary navigation">
            <a className="home-nav-link" href="#recent-workflows">
              <DashboardIcon size={16} />
              <span>Workflows</span>
            </a>
          </nav>
        </div>
      </header>

      <section className="home-hero">
        <div className="home-hero-inner">
          <div className="hero-copy">
            <span className="hero-kicker">Local workflow builder</span>
            <h1>
              Turn an idea into a <span>working flow.</span>
            </h1>
            <p>Describe the outcome. Your agents will handle the steps.</p>
          </div>

          <CreateWorkflowPanel
            prompt={prompt}
            agents={agents}
            agent={effectiveAgent}
            model={model}
            modelOptions={modelOptions}
            cwd={cwd}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            agentsWarning={agentsWarning}
            isCreating={isCreating}
            createError={createError}
            createDiagnostics={createDiagnostics}
            onPromptChange={setPrompt}
            onAgentChange={setAgent}
            onModelChange={setModel}
            onCwdChange={setCwd}
            onRetryAgents={retryAgents}
            onCreate={createWorkflow}
          />
        </div>
      </section>

      <WorkflowBlueprintLibrary />

      <section className="workflow-index" id="recent-workflows">
        <div className="section-heading">
          <div className="section-heading-main">
            <h2>Recent workflows</h2>
            <p>
              {filteredWorkflows.length} of {workflowCount} workflows ·{" "}
              {runCount} runs
            </p>
          </div>
          <div className="workflow-heading-tools">
            <WorkflowIndexToolbar
              query={query}
              statusFilter={statusFilter}
              onQueryChange={setQuery}
              onStatusFilterChange={setStatusFilter}
            />
            <ImportWorkflowDialog
              file={importFile}
              isImporting={isImporting}
              importError={importError}
              importDiagnostics={importDiagnostics}
              onFileChange={setImportFile}
              onImport={importWorkflow}
            />
          </div>
        </div>
        {actionError ? <div className="diagnostic error">{actionError}</div> : null}
        <WorkflowGrid
          workflows={filteredWorkflows}
          hasAnyWorkflow={workflows.length > 0}
          loading={isLoadingWorkflows}
          duplicatingId={duplicatingId}
          deletingId={deletingId}
          onCreateWorkflowFocus={() => {
            document.getElementById("workflow-prompt")?.focus();
          }}
          onDuplicateWorkflow={duplicateWorkflow}
          onDeleteWorkflow={deleteWorkflow}
        />
        <p className="local-note">Workflows are stored locally on your machine.</p>
      </section>
    </main>
  );
}
