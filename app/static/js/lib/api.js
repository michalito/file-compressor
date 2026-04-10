/**
 * Fetch wrapper with CSRF token, error handling, and 401 redirect.
 */

function getCSRFToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

function isLoginRedirect(response) {
  if (!response.redirected) return false;

  try {
    const url = new URL(response.url, window.location.origin);
    return url.pathname === '/login';
  } catch {
    return false;
  }
}

async function parseJSONError(response, fallback) {
  try {
    return await response.clone().json();
  } catch {
    return fallback;
  }
}

/**
 * Make an API request.
 * @param {string} url
 * @param {Object} options
 * @returns {Promise<Response>}
 */
export async function api(url, options = {}) {
  const defaults = {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'fetch',
    },
  };

  const merged = { ...defaults, ...options };
  const headers = new Headers(defaults.headers);

  if (options.headers) {
    const optionHeaders = options.headers instanceof Headers
      ? options.headers.entries()
      : Object.entries(options.headers);

    for (const [key, value] of optionHeaders) {
      headers.set(key, value);
    }
  }

  merged.headers = headers;

  // Add CSRF token for non-GET requests
  if (merged.method && merged.method !== 'GET') {
    if (merged.body instanceof FormData) {
      merged.body.set('csrf_token', getCSRFToken());
    } else if (merged.headers.get('Content-Type') === 'application/json') {
      merged.headers.set('X-CSRFToken', getCSRFToken());
    }
  }

  const response = await fetch(url, merged);

  if (isLoginRedirect(response)) {
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  // Handle auth redirect
  if (response.status === 401) {
    const err = await parseJSONError(response, null);

    if (err?.redirect) {
      window.location.href = err.redirect;
    } else {
      window.location.href = '/login';
    }

    throw new Error('Session expired');
  }

  if (response.status === 400) {
    const err = await parseJSONError(response, null);

    if (err?.code === 'csrf_failed') {
      window.location.reload();
      return new Promise(() => {});
    }
  }

  return response;
}

/**
 * POST JSON data.
 * @param {string} url
 * @param {Object} data
 * @param {Object} [options] - Additional options (e.g. { signal })
 */
export async function postJSON(url, data, { signal } = {}) {
  const response = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  return response;
}

/**
 * POST FormData.
 * @param {string} url
 * @param {FormData} formData
 * @param {Object} [options] - Additional options (e.g. { signal })
 */
export async function postForm(url, formData, { signal } = {}) {
  const response = await api(url, {
    method: 'POST',
    body: formData,
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  return response;
}
