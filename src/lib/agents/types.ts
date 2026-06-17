export type AgentProviderOption = {
  id: string;
  label: string;
  supported: boolean;
  models: string[];
  reason?: string;
};

export type AgentRunInput = {
  runId: string;
  provider: string;
  cwd: string;
  prompt: string;
  model?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type AgentRuntimeEvent =
  | {
      type: "status";
      status?: "initializing" | "detecting" | "spawning" | "running" | "warning";
      stage?: "detecting" | "spawning" | "running" | "warning";
      message?: string;
    }
  | {
      type: "thinking";
      text: string;
    }
  | {
      type: "thinking_delta";
      text: string;
    }
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input?: unknown;
    }
  | {
      type: "tool_result";
      id: string;
      name?: string;
      status?: "completed" | "failed";
      output?: unknown;
      summary?: string;
      error?: string;
      isError?: boolean;
    }
  | {
      type: "usage";
      usage: unknown;
    }
  | {
      type: "file_write";
      path: string;
    }
  | {
      type: "stderr";
      text: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
      retryable?: boolean;
    }
  | {
      type: "done";
      status?: "completed" | "failed" | "canceled";
      reason?: "completed" | "cancelled" | "error";
      exitCode?: number | null;
      sessionId?: string;
      resumeToken?: string;
    };

export type AgentRuntimeAdapter = {
  id: string;
  label: string;
  listProviders(): Promise<AgentProviderOption[]>;
  run(input: AgentRunInput): AsyncGenerator<AgentRuntimeEvent>;
  cancel?(runId: string): Promise<void>;
};
