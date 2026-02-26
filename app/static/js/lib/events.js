/**
 * Simple pub/sub event bus.
 */
class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);

    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from an event.
   */
  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * Emit an event with data.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (err) {
          console.error(`Event handler error [${event}]:`, err);
        }
      }
    }
  }
}

export const bus = new EventBus();
