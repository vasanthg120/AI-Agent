import axios from 'axios';

export function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return 'Could not reach the backend — is it running?';
    if (error.response.status === 401) return 'Your session has expired — please log in again.';
    const backendMessage = (error.response.data as { message?: string | string[] } | undefined)?.message;
    if (Array.isArray(backendMessage)) return backendMessage.join(', ');
    if (backendMessage) return backendMessage;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

// For a login attempt specifically — never call this on an authenticated
// request's error. A 401 here always means the submitted credentials were
// rejected, never an expired session (there was no session yet to expire),
// so unlike extractErrorMessage above it surfaces the backend's real message
// (e.g. "Invalid credentials") instead of hardcoding session-expiry wording.
export function extractLoginErrorMessage(error: unknown, fallback = 'Invalid email or password.'): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return 'Could not reach the backend — is it running?';
    const backendMessage = (error.response.data as { message?: string | string[] } | undefined)?.message;
    if (Array.isArray(backendMessage)) return backendMessage.join(', ');
    if (backendMessage) return backendMessage;
    return fallback;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}
