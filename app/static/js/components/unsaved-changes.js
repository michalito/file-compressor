/**
 * Beforeunload guard — warns users before losing uploaded/processed files.
 */
import { bus } from '../lib/events.js';
import { state } from '../state/app-state.js';

let listening = false;

function onBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}

function update() {
  const hasFiles = state.files.size > 0;
  if (hasFiles && !listening) {
    window.addEventListener('beforeunload', onBeforeUnload);
    listening = true;
  } else if (!hasFiles && listening) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    listening = false;
  }
}

export function initUnloadWarning() {
  bus.on('files:added', update);
  bus.on('files:removed', update);
  bus.on('files:cleared', update);
  bus.on('files:countChanged', update);
  update();
}
