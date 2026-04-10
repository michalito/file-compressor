/**
 * Crop interaction engine: DOM-based overlay with draggable selection and resize handles.
 * Uses normalized image-relative coordinates so the selection survives layout changes.
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

    // Selection in normalized image space (0..1)
    this._sel = { x: 0, y: 0, width: 1, height: 1 };

    // Drag state in display pixels
    this._dragging = null; // null | 'move' | 'create' | handle name (nw, n, ne, e, se, s, sw, w)
    this._dragStart = { x: 0, y: 0 };
    this._dragSelStart = { x: 0, y: 0, width: 0, height: 0 };
    this._createAnchor = { x: 0, y: 0 };

    this._raf = null;
    this._dirty = false;

    this._buildDOM();
    this._bindEvents();
    this._initSelection();
  }

  _buildDOM() {
    this._overlayTop = this._makeDiv('crop-editor__overlay-top');
    this._overlayBottom = this._makeDiv('crop-editor__overlay-bottom');
    this._overlayLeft = this._makeDiv('crop-editor__overlay-left');
    this._overlayRight = this._makeDiv('crop-editor__overlay-right');

    this._selEl = this._makeDiv('crop-editor__selection');
    this._selEl.setAttribute('role', 'application');
    this._selEl.setAttribute('aria-label', 'Crop selection. Use arrow keys to move, Shift+arrow to resize.');
    this._selEl.setAttribute('tabindex', '0');

    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    this._handles = {};
    for (const dir of handles) {
      const handle = this._makeDiv(`crop-editor__handle crop-editor__handle--${dir}`);
      handle.dataset.handle = dir;
      this._handles[dir] = handle;
      this._selEl.appendChild(handle);
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

  _initSelection() {
    this._sel = { x: 0, y: 0, width: 1, height: 1 };
    this._render();
    this._notify();
  }

  reset() {
    const ir = this._getImageRect();
    if (this._aspectRatio) {
      const fitted = this._fitRatio(ir.width, ir.height, this._aspectRatio);
      this._setFromDisplayRect({
        x: (ir.width - fitted.width) / 2,
        y: (ir.height - fitted.height) / 2,
        width: fitted.width,
        height: fitted.height,
      }, ir);
    } else {
      this._sel = { x: 0, y: 0, width: 1, height: 1 };
    }

    this._render();
    this._notify();
  }

  setAspectRatio(ratio) {
    this._aspectRatio = ratio;
    if (ratio) {
      this._constrainToRatio();
      this._render();
      this._notify();
    }
  }

  _constrainToRatio() {
    const ir = this._getImageRect();
    const sel = this._getDisplaySelection(ir);
    const cx = sel.x + sel.width / 2;
    const cy = sel.y + sel.height / 2;

    let width = sel.width;
    let height = sel.height;

    if (width / height > this._aspectRatio) {
      width = height * this._aspectRatio;
    } else {
      height = width / this._aspectRatio;
    }

    const fitted = this._fitRatio(
      Math.min(width, ir.width),
      Math.min(height, ir.height),
      this._aspectRatio
    );

    this._setFromDisplayRect({
      x: cx - fitted.width / 2,
      y: cy - fitted.height / 2,
      width: fitted.width,
      height: fitted.height,
    }, ir);
  }

  _fitRatio(maxW, maxH, ratio) {
    const minW = Math.min(MIN_SIZE, maxW);
    const minH = Math.min(MIN_SIZE, maxH);

    let width = maxW;
    let height = width / ratio;
    if (height > maxH) {
      height = maxH;
      width = height * ratio;
    }

    return {
      width: Math.min(maxW, Math.max(minW, width)),
      height: Math.min(maxH, Math.max(minH, height)),
    };
  }

  _getDisplaySelection(ir = this._getImageRect()) {
    return {
      x: this._sel.x * ir.width,
      y: this._sel.y * ir.height,
      width: this._sel.width * ir.width,
      height: this._sel.height * ir.height,
    };
  }

  _setFromDisplayRect(rect, ir = this._getImageRect()) {
    if (ir.width <= 0 || ir.height <= 0) return;

    const minW = Math.min(MIN_SIZE, ir.width);
    const minH = Math.min(MIN_SIZE, ir.height);

    let width = Math.min(ir.width, Math.max(minW, rect.width));
    let height = Math.min(ir.height, Math.max(minH, rect.height));
    let x = Math.max(0, Math.min(rect.x, ir.width - width));
    let y = Math.max(0, Math.min(rect.y, ir.height - height));

    if (x + width > ir.width) x = ir.width - width;
    if (y + height > ir.height) y = ir.height - height;

    this._sel = {
      x: ir.width ? x / ir.width : 0,
      y: ir.height ? y / ir.height : 0,
      width: ir.width ? width / ir.width : 1,
      height: ir.height ? height / ir.height : 1,
    };
  }

  getSelection() {
    return this._getDisplaySelection();
  }

  getImageCoordinates() {
    const natW = this._image.naturalWidth;
    const natH = this._image.naturalHeight;

    const x = Math.max(0, Math.round(this._sel.x * natW));
    const y = Math.max(0, Math.round(this._sel.y * natH));
    const width = Math.max(1, Math.round(this._sel.width * natW));
    const height = Math.max(1, Math.round(this._sel.height * natH));

    return {
      x: Math.min(x, natW - 1),
      y: Math.min(y, natH - 1),
      width: Math.min(width, natW - x),
      height: Math.min(height, natH - y),
    };
  }

  _bindEvents() {
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onResize = () => {
      this._render();
      this._notify();
    };

    this._container.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    this._selEl.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize', this._onResize);
  }

  _getPointerInImage(e, ir) {
    const containerRect = this._container.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(e.clientX - containerRect.left - ir.x, ir.width)),
      y: Math.max(0, Math.min(e.clientY - containerRect.top - ir.y, ir.height)),
    };
  }

  _handlePointerDown(e) {
    e.preventDefault();
    const ir = this._getImageRect();
    const point = this._getPointerInImage(e, ir);
    const displaySel = this._getDisplaySelection(ir);

    this._dragStart = point;
    this._dragSelStart = { ...displaySel };

    const handle = e.target.closest('[data-handle]');
    if (handle) {
      this._dragging = handle.dataset.handle;
      this._container.setPointerCapture(e.pointerId);
      return;
    }

    const { x, y, width, height } = displaySel;
    if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) {
      this._dragging = 'move';
      this._container.setPointerCapture(e.pointerId);
      return;
    }

    this._dragging = 'create';
    this._createAnchor = point;
    this._setFromDisplayRect({ x: point.x, y: point.y, width: 0, height: 0 }, ir);
    this._container.setPointerCapture(e.pointerId);
  }

  _handlePointerMove(e) {
    if (!this._dragging) return;
    e.preventDefault();

    const ir = this._getImageRect();
    const point = this._getPointerInImage(e, ir);
    const dx = point.x - this._dragStart.x;
    const dy = point.y - this._dragStart.y;

    if (this._dragging === 'move') {
      this._handleMove(dx, dy, ir);
    } else if (this._dragging === 'create') {
      this._handleCreate(point.x, point.y, ir);
    } else {
      this._handleResize(this._dragging, dx, dy, ir);
    }

    this._scheduleRender();
  }

  _handlePointerUp() {
    if (!this._dragging) return;
    this._dragging = null;
    this._render();
    this._notify();
  }

  _handleMove(dx, dy, ir) {
    const sel = this._dragSelStart;

    this._setFromDisplayRect({
      x: sel.x + dx,
      y: sel.y + dy,
      width: sel.width,
      height: sel.height,
    }, ir);
  }

  _handleCreate(px, py, ir) {
    const ax = this._createAnchor.x;
    const ay = this._createAnchor.y;

    let x = Math.min(ax, px);
    let y = Math.min(ay, py);
    let width = Math.abs(px - ax);
    let height = Math.abs(py - ay);

    if (this._aspectRatio) {
      if (width / (height || 1) > this._aspectRatio) {
        width = height * this._aspectRatio;
      } else {
        height = width / this._aspectRatio;
      }

      x = px < ax ? ax - width : ax;
      y = py < ay ? ay - height : ay;
    }

    if (x < 0) {
      width += x;
      x = 0;
    }
    if (y < 0) {
      height += y;
      y = 0;
    }
    if (x + width > ir.width) width = ir.width - x;
    if (y + height > ir.height) height = ir.height - y;

    if (this._aspectRatio) {
      const fitted = this._fitRatio(width, height, this._aspectRatio);
      width = fitted.width;
      height = fitted.height;
    }

    this._setFromDisplayRect({ x, y, width, height }, ir);
  }

  _handleResize(handle, dx, dy, ir) {
    const sel = this._dragSelStart;
    let x = sel.x;
    let y = sel.y;
    let width = sel.width;
    let height = sel.height;

    if (handle.includes('e')) width = sel.width + dx;
    if (handle.includes('w')) {
      x = sel.x + dx;
      width = sel.width - dx;
    }
    if (handle.includes('s')) height = sel.height + dy;
    if (handle.includes('n')) {
      y = sel.y + dy;
      height = sel.height - dy;
    }

    const minW = Math.min(MIN_SIZE, ir.width);
    const minH = Math.min(MIN_SIZE, ir.height);

    if (width < minW) {
      if (handle.includes('w')) x = sel.x + sel.width - minW;
      width = minW;
    }
    if (height < minH) {
      if (handle.includes('n')) y = sel.y + sel.height - minH;
      height = minH;
    }

    if (this._aspectRatio) {
      const isCorner = handle.length === 2;
      const isHorizontal = handle === 'e' || handle === 'w';
      const isVertical = handle === 'n' || handle === 's';

      if (isHorizontal || isCorner) {
        height = width / this._aspectRatio;
        if (handle.includes('n')) {
          y = sel.y + sel.height - height;
        }
      } else if (isVertical) {
        width = height * this._aspectRatio;
        if (handle.includes('w')) {
          x = sel.x + sel.width - width;
        }
      }
    }

    if (x < 0) {
      width += x;
      x = 0;
    }
    if (y < 0) {
      height += y;
      y = 0;
    }
    if (x + width > ir.width) width = ir.width - x;
    if (y + height > ir.height) height = ir.height - y;

    if (this._aspectRatio) {
      const fitted = this._fitRatio(width, height, this._aspectRatio);
      if (fitted.width < width && handle.includes('w')) {
        x += width - fitted.width;
      }
      if (fitted.height < height && handle.includes('n')) {
        y += height - fitted.height;
      }
      width = fitted.width;
      height = fitted.height;
    }

    this._setFromDisplayRect({ x, y, width, height }, ir);
  }

  _handleKeyDown(e) {
    const step = e.shiftKey ? 10 : 1;
    const ir = this._getImageRect();
    const sel = this._getDisplaySelection(ir);
    let next = { ...sel };
    let handled = true;

    if (e.shiftKey) {
      const isHorizontal = e.key === 'ArrowRight' || e.key === 'ArrowLeft';

      switch (e.key) {
        case 'ArrowRight':
          next.width = Math.min(sel.width + step, ir.width - sel.x);
          break;
        case 'ArrowLeft':
          next.width = Math.max(Math.min(MIN_SIZE, ir.width), sel.width - step);
          break;
        case 'ArrowDown':
          next.height = Math.min(sel.height + step, ir.height - sel.y);
          break;
        case 'ArrowUp':
          next.height = Math.max(Math.min(MIN_SIZE, ir.height), sel.height - step);
          break;
        default:
          handled = false;
      }

      if (handled && this._aspectRatio) {
        if (isHorizontal) {
          next.height = next.width / this._aspectRatio;
        } else {
          next.width = next.height * this._aspectRatio;
        }

        next.width = Math.min(next.width, ir.width - next.x);
        next.height = Math.min(next.height, ir.height - next.y);

        const fitted = this._fitRatio(next.width, next.height, this._aspectRatio);
        next.width = fitted.width;
        next.height = fitted.height;
      }
    } else {
      switch (e.key) {
        case 'ArrowRight':
          next.x = Math.min(sel.x + step, ir.width - sel.width);
          break;
        case 'ArrowLeft':
          next.x = Math.max(0, sel.x - step);
          break;
        case 'ArrowDown':
          next.y = Math.min(sel.y + step, ir.height - sel.height);
          break;
        case 'ArrowUp':
          next.y = Math.max(0, sel.y - step);
          break;
        default:
          handled = false;
      }
    }

    if (!handled) return;

    e.preventDefault();
    this._setFromDisplayRect(next, ir);
    this._render();
    this._notify();
  }

  _scheduleRender() {
    if (this._dirty) return;
    this._dirty = true;
    this._raf = requestAnimationFrame(() => {
      this._dirty = false;
      this._render();
      this._notify();
    });
  }

  _render() {
    const ir = this._getImageRect();
    const sel = this._getDisplaySelection(ir);
    const imgX = ir.x;
    const imgY = ir.y;

    this._overlayTop.style.cssText =
      `left:${imgX}px;top:${imgY}px;width:${ir.width}px;height:${Math.max(0, sel.y)}px`;

    this._overlayBottom.style.cssText =
      `left:${imgX}px;top:${imgY + sel.y + sel.height}px;width:${ir.width}px;height:${Math.max(0, ir.height - sel.y - sel.height)}px`;

    this._overlayLeft.style.cssText =
      `left:${imgX}px;top:${imgY + sel.y}px;width:${Math.max(0, sel.x)}px;height:${sel.height}px`;

    this._overlayRight.style.cssText =
      `left:${imgX + sel.x + sel.width}px;top:${imgY + sel.y}px;width:${Math.max(0, ir.width - sel.x - sel.width)}px;height:${sel.height}px`;

    this._selEl.style.cssText =
      `left:${imgX + sel.x}px;top:${imgY + sel.y}px;width:${sel.width}px;height:${sel.height}px`;
  }

  _notify() {
    this._onChange(this.getImageCoordinates());
  }

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
