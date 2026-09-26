// Owner sign-in helpers (no DOM), shared by the Workspace V2 client and tests.

// Turns a failed "send code" response into an honest message. Only a 403 means
// the email is not the owner's; a rate limit means a code was already sent.
export function loginErrorMessage(status, body = {}) {
  const detail = String(body.error || '');
  if (status === 403) return 'That email cannot sign in.';
  if (status === 429 || /rate limit|security purposes|only request this after/i.test(detail)) return 'A code was sent recently. Wait about a minute before requesting another one, or enter the code you already received.';
  if (status === 400) return detail || 'Enter a valid email address.';
  return 'Could not send the code right now. Please try again in a minute.';
}
