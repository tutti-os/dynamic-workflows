export const meta = {
  name: "Research Fan-Out Report",
  description: "Decompose a research topic into sub-questions as JSON, fan out one researcher per sub-question with an adversarial fact-check step, then synthesize a cited report that preserves per-claim confidence and a coverage section for failed or low-confidence items.",
};

export const inputs = {
  research_topic: {
    type: "string",
    required: true,
    label: "Research topic",
    description: "The one description every role reads. Include: 1) the core question to answer; 2) the audience and how the answer will be used; 3) the depth expected (quick orientation vs. thorough survey); 4) what is explicitly out of scope. Be concrete — the plan step decomposes exactly what you write here.",
    placeholder: "Question:\n\nAudience & use:\n\nDepth expected:\n\nOut of scope:\n",
    widget: "textarea",
  },
};

phase("Plan");

const plan = agent({
  id: "plan",
  label: "Decompose the topic",
  output: "json",
  prompt: "You are a research planner. Decompose the research topic below into the smallest set of sub-questions that, answered together, fully cover it for the stated audience and depth. Do not answer them yet.\n\nRules:\n1. Produce between 3 and 6 sub-questions — no fewer, no more. Each must be independently researchable and non-overlapping; together they must span the topic without drifting into the stated out-of-scope areas.\n2. Give each a stable short id (\"q1\", \"q2\", ...), the question itself, and a one-sentence why that ties it back to the topic.\n3. If the topic is broad enough that 6 sub-questions cannot cover it, choose the 6 highest-value ones and make q6's why note what was left out — do not silently drop scope.\n\nOutput contract: end your message with ONLY a JSON array shaped [{\"id\": \"q1\", \"question\": \"...\", \"why\": \"...\"}], with no prose after it.\n\nResearch topic:\n{{research_topic}}",
});

phase("Research");

const research_each = map({
  id: "research_each",
  label: "Research each sub-question",
  source: plan,
  maxItems: 6,
  onItemFailure: "skip",
  steps: [
    agent({
      id: "research_one",
      label: "Research {{item.id}}",
      prompt: "You research exactly one sub-question from a larger plan; other sub-questions are handled by parallel researchers, so stay strictly within this one. Produce the answer itself, not a description of how you researched it — a later step merges it with the others.\n\nInstructions:\n1. Answer the sub-question thoroughly enough for the stated audience and depth.\n2. If your runtime has web access, ground every non-obvious claim in a specific source and cite it inline (title/publisher plus URL where available); prefer primary and recent sources.\n3. If your runtime has NO web access, answer from your own knowledge and explicitly mark every claim you cannot verify from first principles with the tag \"unverified\" — honest gaps beat confident fabrication. Never invent a citation.\n4. Note any part of the sub-question you could not answer.\n\nOutput contract: the sub-question restated, then the answer as a short set of claims each with its citation or \"unverified\" tag, then an \"Open gaps\" line.\n\nResearch topic (for context and scope only):\n{{research_topic}}\n\nSub-question {{item_index}}:\n{{item}}",
    }),
    agent({
      id: "fact_check_one",
      label: "Fact-check {{item.id}}",
      prompt: "You independently fact-check the answer to exactly this one sub-question. Do not redo the research and do not touch other sub-questions. Be adversarial: for each key claim, actively try to REFUTE it — look for a contradicting source, an overreach beyond what the cited source supports, or a fabricated or missing citation.\n\nInstructions:\n1. When your runtime has web access, check claims against sources; when it does not, check them for internal consistency and against your own knowledge, and treat any \"unverified\" tag as unproven.\n2. Default to flagging when uncertain: if you cannot confirm a claim, drop it or mark it unverified rather than letting it stand.\n3. Restate the answer keeping ONLY the claims that survive scrutiny, each with its surviving citation or an \"unverified\" tag; list refuted or removed claims separately with the reason.\n\nOutput contract: the surviving answer, then a \"Removed/flagged\" section, then a final line that is exactly one of: Confidence: high | Confidence: medium | Confidence: low.\n\nResearch topic (for context and scope only):\n{{research_topic}}\n\nSub-question {{item_index}}:\n{{item}}\n\nProposed answer to check:\n{{research_one}}",
    }),
  ],
});

phase("Report");

agent({
  id: "report",
  label: "Synthesize report",
  inputs: { research_each },
  prompt: "You assemble the final research report from the per-sub-question results below. Each result was independently fact-checked and ends with a Confidence line; treat that verdict as authoritative.\n\nInstructions:\n1. Open with a short direct answer to the overall topic for the stated audience.\n2. Then one section per sub-question, ordered by the original plan order (q1, q2, ...). Keep each surviving claim with its citation or \"unverified\" tag, and carry the per-sub-question Confidence forward — do not launder a low-confidence answer into a confident one.\n3. End with a Coverage section that lists: every sub-question in the failed list with its error, every answer marked Confidence: low, and every claim still tagged unverified. Unaccepted or weak findings must stay visible, never summarized away.\n\nResearch topic:\n{{research_topic}}\n\nPer-sub-question results (items, failed, total):\n{{research_each}}",
});
