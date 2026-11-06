export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let session = null;

/**
 * Call when the active profile changes, before anything requests data with it.
 * onExpired(profile) fires once when the backend reports that profile's token is dead.
 */
export function bindSession(profile, onExpired) {
  session = profile ? { profile, onExpired, expired: false } : null;
}

async function errorMessage(response) {
  try {
    const { detail } = await response.json();
    if (typeof detail === "string") return detail;
  } catch {
    // not JSON, e.g. an nginx error page
  }
  return `Error ${response.status}`;
}

async function request(method, path, { body, signal } = {}) {
  // Captured at send time: a late 401 from a request made with the previous
  // profile must not count against the profile active by the time it arrives.
  const sentWith = session;

  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      ...(body !== undefined && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(0, "Could not reach the server. Check your connection.");
  }

  if (response.status === 401 && sentWith && !sentWith.expired) {
    sentWith.expired = true;
    sentWith.onExpired(sentWith.profile);
  }
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));

  try {
    return await response.json();
  } catch {
    throw new ApiError(response.status, "The server sent an unreadable response.");
  }
}

export const api = {
  get: (path, options) => request("GET", path, options),
  post: (path, body, options) => request("POST", path, { ...options, body }),
  delete: (path) => request("DELETE", path),
};
