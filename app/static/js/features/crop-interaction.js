/**
 * Crop interaction engine: DOM-based overlay with draggable selection and resize handles.
 * Uses pointer events for unified mouse + touch support.
 */

const MIN_SIZE = 10; // Minimum crop selection in display pixels

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

export class CropInteraction {
  /**
   * @param {HTMLElement} container - The canvas-area element
   * @param {HTMLImageElement} image - The displayed image element
   * @param {(rect: Rect) => void} onChange - Called on every selection change
   */
  constructor(container, image, onChange) {
    this._container = container;
    this._image = image;
    this._onChange = onChange;
    this._aspectRatio = null;

    // Selection in display pixels (relative to image position within container)
    this._sel = { x: 0, y: 0, width: 0, height: 0 };

    // Drag state
    this._dragging = null; // null | 'move' | 'create' | handle name (nw, n, ne, e, se, s, sw, w)
    this._dragStart = { x: 0, y: 0 };
    this._dragSelStart = { x: 0, y: 0, width: 0, height: 0 };
    this._createAnchor = { x: 0, y: 0 };

    this._raf = null;
    this._dirty = false;

    this._buildDOM();
    this._bindEvents();

    // Initialize selection to full image after it has been laid out
    this._initSelection();
  }

  /** Build the overlay DOM elements */
  _buildDOM() {
    // Overlay regions (dark areas around selection)
    this._overlayTop = this._makeDiv('crop-editor__overlay-top');
    this._overlayBottom = this._makeDiv('crop-editor__overlay-bottom');
    this._overlayLeft = this._makeDiv('crop-editor__overlay-left');
    this._overlayRight = this._makeDiv('crop-editor__overlay-right');

    // Selection rectangle
    this._selEl = this._makeDiv('crop-editor__selection');
    this._selEl.setAttribute('role', 'application');
    this._selEl.setAttribute('aria-label', 'Crop selection. Use arrow keys to move, Shift+arrow to resize.');
    this._selEl.setAttribute('tabindex', '0');

    // 8 handles
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    this._handles = {};
    for (const dir of handles) {
      const h = this._makeDiv(`crop-editor__handle crop-editor__handle--${dir}`);
      h.dataset.handle = dir;
      this._handles[dir] = h;
      this._selEl.appendChild(h);
    }

    this._container.appendChild(this._overlayTop);
    this._container.appendChild(this._overlayBottom);
    this._container.appendChild(this._overlayLeft);
    this._container.appendChild(this._overlayRight);
    this._container.appendChild(this._selEl);
  }

  _makeDiv(className) {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  /** Get the image's bounding rect relative to the container */
  _getImageRect() {
    const cRect = this._container.getBoundingClientRect();
    const iRect = this._image.getBoundingClientRect();
    return {
      x: iRect.left - cRect.left,
      y: iRect.top - cRect.top,
      width: iRect.width,
      height: iRect.height,
    };
  }

  /** Initialize selection to full image */
  _initSelection() {
    const ir = this._getImageRect();
    this._sel = { x: 0, y: 0, width: ir.width, height: ir.height };
    this._render();
    this._notify();
  }

  /** Reset selection to full image, applying aspect ratio if set */
  reset() {
    const ir = this._getImageRect();
    if (this._aspectRatio) {
      const { width, height } = this._fitRatio(ir.width, ir.height, this._aspectRatio);
      this._sel = {
        x: (ir.width - width) / 2,
        y: (ir.height - height) / 2,
        width,
        height,
      };
    } else {
      this._sel = { x: 0, y: 0, width: ir.width, height: ir.height };
    }
    this._render();
    this._notify();
  }

  /** Set aspect ratio constraint. null = freeform. */
  setAspectRatio(ratio) {
    this._aspectRatio = ratio;
    if (ratio) {
      // Constrain current selection to new ratio
      this._constrainToRatio();
      this._render();
      this._notify();
    }
  }

  /** Constrain the current selection to the aspect ratio, centered */
  _constrainToRatio() {
    const ir = this._getImageRect();
    const { x, y, width, height } = this._sel;
    const cx = x + width / 2;
    const cy = y + height / 2;

    let newW, newH;
    if (width / height > this._aspectRatio) {
      newH = height;
      newW = height * this._aspectRatio;
    } else {
      newW = width;
      newH = width / this._aspectRatio;
    }

    // Fit within image bounds
    const fitted = this._fitRatio(
      Math.min(newW, ir.width),
      Math.min(newH, ir.height),
      this._aspectRatio
    );
    newW = fitted.width;
    newH = fitted.height;

    let newX = cx - newW / 2;
    let newY = cy - newH / 2;

    // Clamp
    newX = Math.max(0, Math.min(newX, ir.width - newW));
    newY = Math.max(0, Math.min(newY, ir.height - newH));

    this._sel = { x: newX, y: newY, width: newW, height: newH };
  }

  /** Fit dimensions to aspect ratio (shrink to fit) */
  _fitRatio(maxW, maxH, ratio) {
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    return { width: Math.max(MIN_SIZE, w), height: Math.max(MIN_SIZE, h) };
  }

  /** Get selection in display coordinates (relative to image top-left) */
  getSelection() {
    return { ...this._sel };
  }

  /** Get selection in actual image pixel coordinates */
  getImageCoordinates() {
    const ir = this._getImageRect();
    const natW = this._image.naturalWidth;
    const natH = this._image.naturalHeight;
    const scaleX = natW / ir.width;
    const scaleY = natH / ir.height;
    return {
      x: Math.max(0, Math.round(this._sel.x * scaleX)),
      y: Math.max(0, Math.round(this._sel.y * scaleY)),
      width: Math.min(natW, Math.max(1, Math.round(this._sel.width * scaleX))),
      height: Math.min(natH, Math.max(1, Math.round(this._sel.height * scaleY))),
    };
  }

  /** Bind pointer and keyboard events */
  _bindEvents() {
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onResize = () => this._scheduleRender();

    this._container.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    this._selEl.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize', this._onResize);
  }

  _handlePointerDown(e) {
    e.preventDefault();
    const ir = this._getImageRect();
    // Clamp pointer to image bounds
    const rawX = e.clientX - this._container.getBoundingClientRect().left - ir.x;
    const rawY = e.clientY - this._container.getBoundingClientRect().top - ir.y;
    const px = Math.max(0, Math.min(rawX, ir.width));
    const py = Math.max(0, Math.min(rawY, ir.height));

    this._dragStart = { x: px, y: py };
    this._dragSelStart = { ...this._sel };

    // Check if we hit a handle
    const handle = e.target.closest('[data-handle]');
    if (handle) {
      this._dragging = handle.dataset.handle;
      this._container.setPointerCapture(e.pointerId);
      return;
    }

    // Check if we hit the selection body
    const { x, y, width, height } = this._sel;
    if (px >= x && px <= x + width && py >= y && py <= y + height) {
      this._dragging = 'move';
      this._container.setPointerCapture(e.pointerId);
      return;
    }

    // Click on empty area — start drawing a new selection
    this._sel = { x: px, y: py, width: 0, height: 0 };
    this._dragging = 'create';
    this._createAnchor = { x: px, y: py };
    this._container.setPointerCapture(e.pointerId);
  }

  _handlePointerMove(e) {
    if (!this._dragging) return;
    e.preventDefault();

    const ir = this._getImageRect();
    const rawPx = e.clientX - this._container.getBoundingClientRect().left - ir.x;
    const rawPy = e.clientY - this._container.getBoundingClientRect().top - ir.y;
    const px = Math.max(0, Math.min(rawPx, ir.width));
    const py = Math.max(0, Math.min(rawPy, ir.height));

    const dx = px - this._dragStart.x;
    const dy = py - this._dragStart.y;

    if (this._dragging === 'move') {
      this._handleMove(dx, dy, ir);
    } else if (this._dragging === 'create') {
      this._handleCreate(px, py, ir);
    } else {
      this._handleResize(this._dragging, dx, dy, ir);
    }

    this._scheduleRender();
  }

  _handlePointerUp(e) {
    if (!this._dragging) return;
    this._dragging = null;

    const ir = this._getImageRect();

    // Ensure minimum size
    if (this._sel.width < MIN_SIZE) this._sel.width = MIN_SIZE;
    if (this._sel.height < MIN_SIZE) this._sel.height = MIN_SIZE;

    // Clamp so the selection stays within the image
    if (this._sel.x + this._sel.width > ir.width) {
      this._sel.x = Math.max(0, ir.width - this._sel.width);
    }
    if (this._sel.y + this._sel.height > ir.height) {
      this._sel.y = Math.max(0, ir.height - this._sel.height);
    }

    this._render();
    this._notify();
  }

  _handleMove(dx, dy, ir) {
    let newX = this._dragSelStart.x + dx;
    let newY = this._dragSelStart.y + dy;
    const { width, height } = this._dragSelStart;

    // Clamp to image bounds
    newX = Math.max(0, Math.min(newX, ir.width - width));
    newY = Math.max(0, Math.min(newY, ir.height - height));

    this._sel = { x: newX, y: newY, width, height };
  }

  _handleCreate(px, py, ir) {
    const ax = this._createAnchor.x;
    const ay = this._createAnchor.y;

    // Clamp pointer to image bounds
    const cx = Math.max(0, Math.min(px, ir.width));
    const cy = Math.max(0, Math.min(py, ir.height));

    // Build rect from anchor and current pointer — works in all four directions
    let x = Math.min(ax, cx);
    let y = Math.min(ay, cy);
    let w = Math.abs(cx - ax);
    let h = Math.abs(cy - ay);

    // Apply aspect ratio constraint
    if (this._aspectRatio) {
      if (w / (h || 1) > this._aspectRatio) {
        w = h * this._aspectRatio;
      } else {
        h = w / this._aspectRatio;
      }
      // Re-anchor: if pointer is left/above anchor, adjust origin
      x = cx < ax ? ax - w : ax;
      y = cy < ay ? ay - h : ay;
    }

    // Clamp to image bounds
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > ir.width) w = ir.width - x;
    if (y + h > ir.height) h = ir.height - y;

    // Re-fit ratio after clamping so both axes stay consistent
    if (this._aspectRatio) {
      const fitted = this._fitRatio(w, h, this._aspectRatio);
      w = fitted.width;
      h = fitted.height;
    }

    this._sel = { x, y, width: Math.max(0, w), height: Math.max(0, h) };
  }

  _handleResize(handle, dx, dy, ir) {
    const s = this._dragSelStart;
    let x = s.x, y = s.y, w = s.width, h = s.height;

    // Apply deltas based on which handle is being dragged
    if (handle.includes('e')) {
      w = s.width + dx;
    }
    if (handle.includes('w')) {
      x = s.x + dx;
      w = s.width - dx;
    }
    if (handle.includes('s')) {
      h = s.height + dy;
    }
    if (handle.includes('n')) {
      y = s.y + dy;
      h = s.height - dy;
    }

    // Enforce minimum size
    if (w < MIN_SIZE) {
      if (handle.includes('w')) { x = s.x + s.width - MIN_SIZE; }
      w = MIN_SIZE;
    }
    if (h < MIN_SIZE) {
      if (handle.includes('n')) { y = s.y + s.height - MIN_SIZE; }
      h = MIN_SIZE;
    }

    // Apply aspect ratio constraint
    if (this._aspectRatio) {
      // Determine which axis drives the resize
      const isCorner = handle.length === 2;
      const isHorizontal = handle === 'e' || handle === 'w';
      const isVertical = handle === 'n' || handle === 's';

      if (isHorizontal || isCorner) {
        h = w / this._aspectRatio;
        // Re-adjust origin for top/left handles
        if (handle.includes('n')) {
          y = s.y + s.height - h;
        }
      } else if (isVertical) {
        w = h * this._aspectRatio;
        if (handle.includes('w')) {
          x = s.x + s.width - w;
        }
      }
    }

    // Clamp to image bounds
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > ir.width) { w = ir.width - x; }
    if (y + h > ir.height) { h = ir.height - y; }

    // If ratio-constrained and clamped, re-fit
    if (this._aspectRatio) {
      const fitted = this._fitRatio(w, h, this._aspectRatio);
      if (fitted.width < w) {
        if (handle.includes('w')) { x = x + w - fitted.width; }
        w = fitted.width;
      }
      if (fitted.height < h) {
        if (handle.includes('n')) { y = y + h - fitted.height; }
        h = fitted.height;
      }
    }

    this._sel = { x, y, width: w, height: h };
  }

  _handleKeyDown(e) {
    const step = e.shiftKey ? 10 : 1;
    const ir = this._getImageRect();
    let handled = true;

    if (e.shiftKey) {
      // Shift+arrow: resize from current origin
      const isHoriz = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
      switch (e.key) {
        case 'ArrowRight': this._sel.width = Math.min(this._sel.width + step, ir.width - this._sel.x); break;
        case 'ArrowLeft': this._sel.width = Math.max(MIN_SIZE, this._sel.width - step); break;
        case 'ArrowDown': this._sel.height = Math.min(this._sel.height + step, ir.height - this._sel.y); break;
        case 'ArrowUp': this._sel.height = Math.max(MIN_SIZE, this._sel.height - step); break;
        default: handled = false;
      }
      // Adjust complementary axis to maintain ratio, anchored at top-left
      if (handled && this._aspectRatio) {
        if (isHoriz) {
          this._sel.height = this._sel.width / this._aspectRatio;
        } else {
          this._sel.width = this._sel.height * this._aspectRatio;
        }
        // Clamp to image bounds, then re-fit ratio if needed
        this._sel.width = Math.min(this._sel.width, ir.width - this._sel.x);
        this._sel.height = Math.min(this._sel.height, ir.height - this._sel.y);
        const fitted = this._fitRatio(this._sel.width, this._sel.height, this._aspectRatio);
        this._sel.width = fitted.width;
        this._sel.height = fitted.height;
      }
    } else {
      // Arrow: move
      switch (e.key) {
        case 'ArrowRight': this._sel.x = Math.min(this._sel.x + step, ir.width - this._sel.width); break;
        case 'ArrowLeft': this._sel.x = Math.max(0, this._sel.x - step); break;
        case 'ArrowDown': this._sel.y = Math.min(this._sel.y + step, ir.height - this._sel.height); break;
        case 'ArrowUp': this._sel.y = Math.max(0, this._sel.y - step); break;
        default: handled = false;
      }
    }

    if (handled) {
      e.preventDefault();
      this._render();
      this._notify();
    }
  }

  /** Schedule a render via rAF */
  _scheduleRender() {
    if (this._dirty) return;
    this._dirty = true;
    this._raf = requestAnimationFrame(() => {
      this._dirty = false;
      this._render();
      this._notify();
    });
  }

  /** Update DOM positions of overlay and selection */
  _render() {
    const ir = this._getImageRect();
    const { x, y, width, height } = this._sel;

    // Position overlays relative to container (using image offset)
    const imgX = ir.x;
    const imgY = ir.y;

    // Top overlay: from image top to selection top
    this._overlayTop.style.cssText =
      `left:${imgX}px;top:${imgY}px;width:${ir.width}px;height:${Math.max(0, y)}px`;

    // Bottom overlay: from selection bottom to image bottom
    this._overlayBottom.style.cssText =
      `left:${imgX}px;top:${imgY + y + height}px;width:${ir.width}px;height:${Math.max(0, ir.height - y - height)}px`;

    // Left overlay: between top and bottom, from image left to selection left
    this._overlayLeft.style.cssText =
      `left:${imgX}px;top:${imgY + y}px;width:${Math.max(0, x)}px;height:${height}px`;

    // Right overlay: between top and bottom, from selection right to image right
    this._overlayRight.style.cssText =
      `left:${imgX + x + width}px;top:${imgY + y}px;width:${Math.max(0, ir.width - x - width)}px;height:${height}px`;

    // Selection rectangle
    this._selEl.style.cssText =
      `left:${imgX + x}px;top:${imgY + y}px;width:${width}px;height:${height}px`;
  }

  /** Notify parent of selection change */
  _notify() {
    this._onChange(this.getImageCoordinates());
  }

  /** Clean up event listeners and DOM */
  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._container.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('resize', this._onResize);
    this._selEl.removeEventListener('keydown', this._onKeyDown);

    this._overlayTop.remove();
    this._overlayBottom.remove();
    this._overlayLeft.remove();
    this._overlayRight.remove();
    this._selEl.remove();
  }
}
