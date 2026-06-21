import {
  readApiError,
  type ApiError,
  type ApiErrorCode,
} from "@/lib/api/errors";

export class ApiJsonError extends Error {
  readonly apiError: ApiError;
  readonly status: number;
  readonly data: unknown;

  constructor(apiError: ApiError, status: number, data: unknown) {
    super(apiError.message);
    this.name = "ApiJsonError";
    this.apiError = apiError;
    this.status = status;
    this.data = data;
  }
}

export async function apiJson<T>(
  url: RequestInfo | URL,
  init?: RequestInit,
  fallbackCode: ApiErrorCode = "UNKNOWN_ERROR",
): Promise<T> {
  const response = await fetch(url, init);
  const data = await readResponseBody(response);
  if (!response.ok) {
    throw new ApiJsonError(readApiError(data, fallbackCode), response.status, data);
  }
  return data as T;
}

export function readApiJsonError(
  error: unknown,
  fallbackCode: ApiErrorCode = "UNKNOWN_ERROR",
): ApiError {
  if (error instanceof ApiJsonError) {
    return error.apiError;
  }
  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: error.message,
    };
  }
  return readApiError(undefined, fallbackCode);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
