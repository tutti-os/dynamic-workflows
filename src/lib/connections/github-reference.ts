export function githubCliConnectionId(host: string, login: string): string {
  return `github-cli:${encodeURIComponent(host)}:${encodeURIComponent(login)}`;
}

export function isSafeGitHubConnectionReference(input: {
  host: unknown;
  login: unknown;
}): input is { host: string; login: string } {
  return isSafeGitHubHost(input.host) && isSafeGitHubLogin(input.login);
}

export function isSafeGitHubHost(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 253 &&
    /^[A-Za-z0-9.-]+$/u.test(value)
  );
}

export function isSafeGitHubLogin(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(value)
  );
}
