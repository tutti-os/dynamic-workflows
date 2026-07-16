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
  step: agent({
    id: "process_one",
    label: "Process {{item.file}}",
    prompt: "You handle exactly one work item from a larger list; other items are handled by parallel agents, so stay strictly within this item's scope. Investigate the item in the repository and produce the per-item deliverable requested by the discovery focus. Output only the deliverable for this item — it is merged with the others by a later step.\n\nWorking directory:\n{{workflow.cwd}}\n\nDiscovery focus:\n{{discovery_focus}}\n\nWork item {{item_index}}:\n{{item}}",
  }),
});

phase("Synthesize");

agent({
  id: "report",
  label: "Synthesize report",
  inputs: { processed },
  prompt: "Merge the per-item results below into one report ordered by the original item index. Keep each item's deliverable intact, and end with a Coverage section that lists every item in the failed list with its error — skipped work must stay visible, never summarized away.\n\nDiscovery focus:\n{{discovery_focus}}\n\nMap results (items, failed, total):\n{{processed}}",
});
