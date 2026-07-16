export const meta = {
  name: "Human Feedback Loop",
  description: "Iterate on an agent result until a person accepts it.",
};

export const inputs = {
  requirement: {
    type: "string",
    required: true,
    label: "Requirement",
    description: "Describe the result the agent should produce.",
    widget: "textarea",
  },
};

const delivery = await loop({
  id: "delivery",
  label: "Deliver with human feedback",
  maxIterations: 5,
  onMaxIterations: "fail",
  steps: [
    agent({
      id: "worker",
      label: "Produce result",
      prompt: "Produce the deliverable that satisfies the requirement below. Your final message is the deliverable itself and is shown to a human reviewer as-is — output the result, not a report about producing it. When previous feedback is present, revise the prior result accordingly instead of starting over.\n\nRequirement:\n{{requirement}}\n\nIteration: {{iteration}}\nPrevious human feedback (empty on the first iteration):\n{{review.values.comment}}",
    }),
    human({
      id: "review",
      label: "Human decision",
      description: "Accept the result or send focused feedback into the next iteration.",
      context: [
        { label: "Current result", value: "{{worker}}", display: "markdown" },
      ],
      actions: [
        { id: "pass", label: "Accept", intent: "primary" },
        {
          id: "revise",
          label: "Request changes",
          fields: [
            {
              id: "comment",
              type: "textarea",
              label: "Feedback",
              required: true,
              placeholder: "Describe what should change in the next iteration.",
            },
          ],
        },
      ],
    }),
  ],
  until: { source: "review.action", equals: "pass" },
});

agent({
  id: "summary",
  label: "Summarize delivery",
  inputs: { delivery },
  prompt: "Summarize the accepted delivery for the user: what was produced, how the feedback rounds shaped it, and where the final result stands.\n\nDelivery loop record:\n{{delivery}}",
});
