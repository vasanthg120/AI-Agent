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

// A request made with responseType:'blob' (audio) gets its error body back as a
// Blob too, so extractErrorMessage can't read the backend's JSON message from
// it. Call this in the catch of such a request — `throw await
// readBlobErrorBody(err)` — and the same axios error comes back with the body
// parsed, so extractErrorMessage works on it unchanged.
export async function readBlobErrorBody(error: unknown): Promise<unknown> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      error.response.data = JSON.parse(await error.response.data.text());
    } catch {
      // Not JSON — leave the generic message rather than lose the error.
    }
  }
  return error;
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
