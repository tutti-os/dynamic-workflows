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
      prompt: "Complete this requirement:\n{{requirement}}\n\nIteration: {{iteration}}\nPrevious human feedback: {{review.values.comment}}",
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
  prompt: "Summarize the accepted delivery and the iteration history:\n{{delivery}}",
});
