/**
 * localStorage wrapper with try-catch safety.
 */

export function getItem(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function setItem(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('localStorage.setItem failed:', err);
  }
}

export function removeItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
