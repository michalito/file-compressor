/**
 * Progress bar controller.
 */
import { $ } from '../lib/dom.js';

export class ProgressController {
  constructor(element) {
    this.element = element;
    this.bar = element ? element.querySelector('.progress__bar, .progress-inline__bar') : null;
  }

  show() {
    if (this.element) this.element.classList.remove('is-hidden');
  }

  hide() {
    if (this.element) this.element.classList.add('is-hidden');
  }

  setProgress(fraction) {
    if (!this.bar) return;
    this.bar.classList.remove('progress__bar--indeterminate', 'progress-inline__bar--indeterminate');
    this.bar.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  }

  setIndeterminate() {
    if (!this.bar) return;
    this.bar.style.width = '';
    const cls = this.bar.classList.contains('progress-inline__bar')
      ? 'progress-inline__bar--indeterminate'
      : 'progress__bar--indeterminate';
    this.bar.classList.add(cls);
  }

  reset() {
    if (this.bar) {
      this.bar.style.width = '0%';
      this.bar.classList.remove('progress__bar--indeterminate', 'progress-inline__bar--indeterminate');
    }
  }
}

/** Global page-level progress bar */
export const globalProgress = new ProgressController($('#global-loader'));
