/**
 * DOM utility helpers — safe, minimal wrappers.
 */

/** querySelector shorthand */
export const $ = (sel, root = document) => root.querySelector(sel);

/** querySelectorAll shorthand (returns real Array) */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Create an element with attributes and children.
 * @param {string} tag
 * @param {Object} attrs - key/value attribute pairs (class, id, etc.)
 * @param  {...(string|Node)} children
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }
  return el;
}

/**
 * Safely set text content (prevents XSS).
 * @param {string} text
 * @returns {string} sanitized text
 */
export function sanitizeText(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Trigger a file download from a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

/**
 * Render an SVG icon from the sprite sheet.
 * @param {string} name - icon name (without 'icon-' prefix)
 * @param {number} size
 * @returns {SVGElement}
 */
export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.appendChild(use);
  return svg;
}
