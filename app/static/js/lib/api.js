/**
 * Fetch wrapper with CSRF token, error handling, and 401 redirect.
 */

function getCSRFToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
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
    headers: {},
  };

  const merged = { ...defaults, ...options };

  // Add CSRF token for non-GET requests
  if (merged.method && merged.method !== 'GET') {
    if (merged.body instanceof FormData) {
      merged.body.append('csrf_token', getCSRFToken());
    } else if (merged.headers['Content-Type'] === 'application/json') {
      merged.headers['X-CSRFToken'] = getCSRFToken();
    }
  }

  const response = await fetch(url, merged);

  // Handle auth redirect
  if (response.status === 401 || response.status === 302) {
    window.location.href = '/login';
    throw new Error('Session expired');
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
