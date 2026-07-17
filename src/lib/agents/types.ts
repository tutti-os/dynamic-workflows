export type AgentPermissionModeOption = {
  id: string;
  label: string;
  description?: string;
  semantic?: string;
};

export type AgentTargetOption = {
  id: string;
  name: string;
  provider: string;
  supported: boolean;
  models: string[];
  permissionModes?: AgentPermissionModeOption[];
  defaultPermissionMode?: string;
  isDefault?: boolean;
  reason?: string;
};

export type AgentTargetCatalogResult = {
  targets: AgentTargetOption[];
  freshness: "fresh" | "stale";
  loadedAt?: number;
  warning?: string;
};

export type AgentRunInput = {
  runId: string;
  agent: string;
  cwd: string;
  prompt: string;
  title?: string;
  model?: string;
  permissionMode?: string;
  resumeSessionId?: string;
  attachSessionId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type AgentSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type AgentSessionRef = {
  agentSessionId: string;
  providerSessionId?: string;
  agent: string;
  model?: string;
  status?: AgentSessionStatus;
  title?: string;
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
      type: "session_ref";
      session: AgentSessionRef;
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

export type AgentSessionStartInput = {
  agent: string;
  model?: string;
  cwd: string;
  prompt: string;
};

export type AgentRuntimeAdapter = {
  id: string;
  label: string;
  listTargets(): Promise<AgentTargetOption[]>;
  listTargetCatalog?(): Promise<AgentTargetCatalogResult>;
  run(input: AgentRunInput): AsyncGenerator<AgentRuntimeEvent>;
  startSession?(input: AgentSessionStartInput): Promise<AgentSessionRef>;
  cancel?(runId: string): Promise<void>;
  cancelSession?(agentSessionId: string): Promise<void>;
  openSession?(agentSessionId: string): Promise<void>;
  /**
   * Deliver an out-of-band message to a live agent session (steering).
   * `guidance` routes it into the currently active turn (instead of starting a
   * new turn), which is required inside a workflow because a node execution is
   * itself an active turn.
   */
  sendToSession?(
    agentSessionId: string,
    message: string,
    options?: { guidance?: boolean },
  ): Promise<void>;
};
