export const SAMPLE_WORKFLOW = `export const meta = {
  name: "repo_review",
  description: "Inspect a codebase with focused local agents and synthesize the results",
}

phase("Scan")

const inventory = await agent({
  id: "inventory",
  label: "Repository inventory",
  prompt: \`
Inspect the repository structure.

Return the main folders, runtime stack, and files that look important for future changes.
  \`,
})

phase("Review")

const architecture = await agent({
  id: "architecture_review",
  label: "Architecture review",
  inputs: { inventory },
  prompt: \`
Review the architecture using this inventory:

{{inventory}}

Focus on module boundaries, data flow, and likely extension points.
  \`,
})

const security = await agent({
  id: "security_review",
  label: "Security review",
  inputs: { inventory },
  prompt: \`
Review security-sensitive areas using this inventory:

{{inventory}}

Look for auth, secrets, shell execution, file writes, and network access.
  \`,
})

phase("Synthesize")

const summary = await agent({
  id: "final_summary",
  label: "Final summary",
  inputs: { architecture, security },
  prompt: \`
Synthesize these reviews into a concise implementation brief.

Architecture:
{{architecture}}

Security:
{{security}}
  \`,
})

log("Workflow completed with final_summary")
`;
