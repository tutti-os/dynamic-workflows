export const meta = {
  name: "Dynamic Fan-Out Demo",
  description: "Discover a work list as JSON, fan out one independent agent per item with map, and synthesize the results — the reference pattern for dynamic-width orchestration.",
  requiresCwd: true,
};

export const inputs = {
  discovery_focus: {
    type: "string",
    required: true,
    label: "Discovery focus",
    description: "What to discover and then process item by item. Include: 1) what counts as a work item (for example TODO/FIXME comments that indicate real work, deprecated API call sites, files missing tests); 2) where to look (directories or modules); 3) what each item's processing should produce.",
    placeholder: "Work items:\n\nWhere to look:\n\nPer-item deliverable:\n",
    widget: "textarea",
  },
};

phase("Discover");

const findings = agent({
  id: "discover",
  label: "Discover work items",
  output: "json",
  prompt: "Discover the work items described by the discovery focus below. Inspect the repository, select at most 8 items that genuinely need work, and end your message with ONLY a JSON array in this exact shape: [{\"file\": \"path/to/file\", \"line\": 1, \"summary\": \"one sentence on what needs doing\"}]. No trailing prose after the JSON. If nothing qualifies, return [].\n\nWorking directory:\n{{workflow.cwd}}\n\nDiscovery focus:\n{{discovery_focus}}",
});

phase("Process");

const processed = map({
  id: "process_each",
  label: "Process each work item",
  source: findings,
  maxItems: 8,
  onItemFailure: "skip",
  steps: [
    agent({
      id: "process_one",
      label: "Process {{item.file}}",
      prompt: "You handle exactly one work item from a larger list; other items are handled by parallel agents, so stay strictly within this item's scope. Investigate the item in the repository and produce the per-item deliverable requested by the discovery focus. Output only the deliverable for this item — it is merged with the others by a later step.\n\nWorking directory:\n{{workflow.cwd}}\n\nDiscovery focus:\n{{discovery_focus}}\n\nWork item {{item_index}}:\n{{item}}",
    }),
    agent({
      id: "verify_one",
      label: "Verify {{item.file}}",
      prompt: "You independently verify the deliverable produced for exactly this one work item. Be adversarial: inspect the actual repository state for this item and try to find a concrete reason the deliverable is wrong, incomplete, or fabricated; when you cannot confirm it, reject it. Do not redo the work and do not touch other items. Restate the deliverable you accept (correcting it only where the evidence forces a change), then end your message with a final line containing only VERIFIED or REJECTED.\n\nWorking directory:\n{{workflow.cwd}}\n\nDiscovery focus:\n{{discovery_focus}}\n\nWork item {{item_index}}:\n{{item}}\n\nProposed deliverable to verify:\n{{process_one}}",
    }),
  ],
});

phase("Synthesize");

agent({
  id: "report",
  label: "Synthesize report",
  inputs: { processed },
  prompt: "Merge the per-item results below into one report ordered by the original item index. Each item's result ends with a VERIFIED or REJECTED verdict from an independent check: present VERIFIED deliverables intact, and list REJECTED items in the Coverage section with the verifier's reason instead of treating their deliverables as accepted. End with that Coverage section covering both REJECTED items and every item in the failed list with its error — unaccepted work must stay visible, never summarized away.\n\nDiscovery focus:\n{{discovery_focus}}\n\nMap results (items, failed, total):\n{{processed}}",
});
