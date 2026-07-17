export const meta = {
  name: "Epic Breakdown Plan",
  description: "Decompose an epic into a task list as JSON and iterate with a human approver until approved, extract the approved task array, then fan out with map to detail each task and assemble an ordered plan with a coverage section for any failed items.",
};

export const inputs = {
  epic_brief: {
    type: "string",
    required: true,
    label: "Epic brief",
    description: "The one description every role reads. Include: 1) the goal of the epic (the outcome, not the tasks); 2) known constraints (tech, deadlines, dependencies, non-goals); 3) any scope already known or fixed; 4) the definition of done for the whole epic. The decompose step splits exactly what you write here, so be concrete about scope boundaries.",
    placeholder: "Goal:\n\nConstraints:\n\nKnown scope:\n\nDefinition of done:\n",
    widget: "textarea",
  },
};

phase("Decompose & approve");

const breakdown = loop({
  id: "breakdown",
  label: "Decompose with human approval",
  maxIterations: 4,
  onMaxIterations: "complete",
  steps: [
    agent({
      id: "decompose",
      label: "Decompose the epic",
      output: "json",
      session: { mode: "inherit", key: "planner" },
      prompt: "You are a planner decomposing an epic into tasks. Split the epic below into the smallest set of tasks that together satisfy its definition of done, without drifting past the stated scope and non-goals.\n\nRules:\n1. Produce between 3 and 10 tasks. Each is one coherent unit of work with a clear boundary; tasks must not overlap, and together they must cover the definition of done.\n2. Give each task a stable short id (\"t1\", \"t2\", ...), a title, a one-sentence goal, and a dependencies array listing the ids it depends on (empty if none). Dependencies must reference ids that exist and must not form a cycle.\n3. Stay at the planning altitude: decide the tasks and their ordering, not their implementation details — a later step expands each task.\n\nOutput contract: end your message with ONLY a JSON array shaped [{\"id\": \"t1\", \"title\": \"...\", \"goal\": \"...\", \"dependencies\": [\"t2\"]}], with no prose after it.\n\nEpic brief:\n{{epic_brief}}",
      appendPrompt: "The human reviewer requested a revision. Stay in this same planning session and revise your PREVIOUS decomposition to address the comment — adjust, split, merge, or reorder tasks as needed; do not restart from scratch and do not drift past the epic's scope or non-goals. Keep the same id scheme where tasks are unchanged so the plan stays stable.\n\nOutput the full revised task array again under the same JSON contract: end with ONLY the JSON array, no prose after it.\n\nReviewer comment:\n{{plan_review.values.comment}}",
    }),
    human({
      id: "plan_review",
      label: "Approve the breakdown",
      description: "Review the proposed task breakdown. Approve it to detail each task, or request a revision with a comment for the planner.",
      context: [
        { label: "Epic brief", value: "{{epic_brief}}", display: "markdown" },
        { label: "Proposed task breakdown", value: "{{decompose}}", display: "json" },
      ],
      actions: [
        { id: "approve", label: "Approve breakdown", intent: "primary" },
        {
          id: "revise",
          label: "Request revision",
          fields: [
            {
              id: "comment",
              type: "textarea",
              label: "Revision comment",
              required: true,
              placeholder: "What to change: tasks to split, merge, add, drop, or reorder.",
            },
          ],
        },
      ],
    }),
  ],
  until: { source: "plan_review.action", equals: "approve" },
});

phase("Extract approved tasks");

const approved_tasks = agent({
  id: "extract",
  label: "Extract approved tasks",
  output: "json",
  inputs: { breakdown },
  prompt: "You extract the approved task list from the breakdown loop record below so it can be processed one task at a time. You are NOT rewriting or re-planning — extract only.\n\nInstructions:\n1. Find the most recent (approved) decomposition in the loop record — the final task array the planner produced.\n2. Re-emit that array VERBATIM: the same task ids, titles, goals, and dependencies. Do not add, remove, merge, reword, or reorder tasks.\n\nOutput contract: end your message with ONLY the JSON array shaped [{\"id\": \"t1\", \"title\": \"...\", \"goal\": \"...\", \"dependencies\": [\"t2\"]}], with no prose after it.\n\nBreakdown loop record:\n{{breakdown}}",
});

phase("Detail each task");

const detail_each = map({
  id: "detail_each",
  label: "Detail each task",
  source: approved_tasks,
  maxItems: 10,
  onItemFailure: "skip",
  step: agent({
    id: "detail_one",
    label: "Detail {{item.title}}",
    prompt: "You expand exactly one task from an approved breakdown into an actionable spec; other tasks are handled by parallel agents, so stay strictly within this one. Produce the spec itself, not a description of your process — a later step assembles it with the others.\n\nInstructions:\n1. Expand this single task into: a scope (what is and is not included), a short numbered list of acceptance criteria that are concrete and verifiable, and the dependencies restated from the task (which other task ids must land first and why).\n2. Do NOT produce time or effort estimates — keep the spec estimate-free.\n3. Stay within this task's stated goal; if it depends on decisions owned by another task, name that dependency rather than deciding it here.\n\nOutput contract: the task id and title, then Scope, then Acceptance criteria, then Dependencies.\n\nEpic brief (for context and scope only):\n{{epic_brief}}\n\nTask {{item_index}}:\n{{item}}",
  }),
});

phase("Assemble plan");

agent({
  id: "final_plan",
  label: "Assemble final plan",
  inputs: { detail_each },
  prompt: "You assemble the final epic plan from the per-task specs below. Each spec was produced from one approved task.\n\nInstructions:\n1. Order the tasks so that every task appears after the tasks it depends on (topological order); when tasks are independent, keep the original id order.\n2. Present each task's full spec (scope, acceptance criteria, dependencies) under a clear heading, in that order.\n3. End with a Coverage section listing every task in the failed list with its error, so any task that could not be detailed stays visible rather than being dropped from the plan.\n\nEpic brief:\n{{epic_brief}}\n\nPer-task specs (items, failed, total):\n{{detail_each}}",
});
