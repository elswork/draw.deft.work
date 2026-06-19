/**
 * Canvas Manager for AirPaint
 * Handles drawing paths, custom brushes, smoothing, and undo/redo history.
 */

export class CanvasManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    // Set size to full screen
    this.resize();
    
    // Multi-hand state storage
    this.handStates = {
      'Left': {
        color: '#f35588', // Default Pink
        brush: 'normal',
        size: 12,
        prevPoint: null
      },
      'Right': {
        color: '#00f2fe', // Default Cyan
        brush: 'normal',
        size: 12,
        prevPoint: null
      }
    };

    // Smooth factor (EMA: Exponential Moving Average)
    // 0.3 means 30% new coordinates, 70% history (high smoothing, low jitter)
    this.smoothingAlpha = 0.32;

    // Undo/Redo Stacks (maximum 20 states)
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 20;

    // Track points for active stroke (Physics mode utility)
    this.physicsMode = false;
    this.activeStrokePoints = { 'Left': [], 'Right': [] };

    // Save initial blank canvas state
    setTimeout(() => this.saveHistoryState(), 500);
  }

  /**
   * Resizes canvas to fill window and maintains painting aspect ratio
   */
  resize() {
    // Save current content before resize to redraw it
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.canvas.width;
    tempCanvas.height = this.canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(this.canvas, 0, 0);

    // Set new dimensions
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;

    // Redraw content scaled to new size
    this.ctx.drawImage(tempCanvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Clears the entire painting canvas
   */
  clear() {
    this.saveHistoryState();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Saves the current canvas state to the Undo stack
   */
  saveHistoryState() {
    if (this.undoStack.length >= this.maxHistory) {
      this.undoStack.shift(); // Remove oldest
    }
    this.undoStack.push(this.canvas.toDataURL());
    this.redoStack = []; // Reset Redo stack
  }

  /**
   * Undoes the last action
   */
  undo() {
    if (this.undoStack.length <= 1) return false; // Keep the base blank state
    
    // Current state goes to redo stack
    this.redoStack.push(this.undoStack.pop());
    
    const prevState = this.undoStack[this.undoStack.length - 1];
    this.loadState(prevState);
    return true;
  }

  /**
   * Redoes the last undone action
   */
  redo() {
    if (this.redoStack.length === 0) return false;
    
    const nextState = this.redoStack.pop();
    this.undoStack.push(nextState);
    this.loadState(nextState);
    return true;
  }

  /**
   * Helper to load canvas state from data URL
   */
  loadState(dataUrl) {
    const img = new Image();
    img.onload = () => {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  }

  /**
   * Reset tracking point when a hand is lost or stops pinching
   */
  resetHandTrack(handedness) {
    if (this.handStates[handedness]) {
      this.handStates[handedness].prevPoint = null;
    }
    if (this.activeStrokePoints && this.activeStrokePoints[handedness]) {
      this.activeStrokePoints[handedness] = [];
    }
  }

  /**
   * Configure brush properties for a specific hand
   */
  setHandColor(handedness, color) {
    if (this.handStates[handedness]) {
      this.handStates[handedness].color = color;
    }
  }

  setHandBrush(handedness, brush) {
    if (this.handStates[handedness]) {
      this.handStates[handedness].brush = brush;
    }
  }

  setHandSize(handedness, size) {
    if (this.handStates[handedness]) {
      this.handStates[handedness].size = size;
    }
  }

  /**
   * Draws a stroke on the canvas based on gesture and current coordinates
   * @param {string} handedness - 'Left' or 'Right'
   * @param {string} gesture - 'DRAW' or 'ERASE'
   * @param {Object} rawPoint - {x, y} normalized coordinates (0.0 to 1.0)
   */
  draw(handedness, gesture, screenPoint) {
    const state = this.handStates[handedness];
    if (!state) return;

    // 1. Use the pre-calculated screen pixel coordinates
    const targetX = screenPoint.x;
    const targetY = screenPoint.y;

    // 2. Apply Exponential Moving Average (EMA) smoothing to reduce jitter
    let currX = targetX;
    let currY = targetY;

    if (state.prevPoint) {
      currX = this.smoothingAlpha * targetX + (1 - this.smoothingAlpha) * state.prevPoint.x;
      currY = this.smoothingAlpha * targetY + (1 - this.smoothingAlpha) * state.prevPoint.y;
    }

    const prev = state.prevPoint || { x: currX, y: currY };

    // Record the current point in active stroke points list if drawing
    if (gesture === 'DRAW') {
      if (!this.activeStrokePoints[handedness]) {
        this.activeStrokePoints[handedness] = [];
      }
      this.activeStrokePoints[handedness].push({ x: currX, y: currY });
    }

    // If physics mode is active, bypass writing directly to canvas 
    // context. The physics rendering engine loop will handle drawing.
    if (this.physicsMode) {
      state.prevPoint = { x: currX, y: currY };
      return;
    }

    // 3. Select brush color (dynamic rainbow hue calculation if preset is rainbow)
    let brushColor = state.color;
    if (state.color === 'rainbow') {
      const hue = (performance.now() / 12) % 360;
      brushColor = `hsl(${hue}, 100%, 55%)`;
    }

    // 4. Render active brush
    this.ctx.save();
    
    if (gesture === 'ERASE') {
      // Eraser mode: behaves as destination-out composition
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.beginPath();
      this.ctx.moveTo(prev.x, prev.y);
      this.ctx.lineTo(currX, currY);
      this.ctx.lineWidth = state.size * 2.5; // Bigger size for eraser
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.stroke();
    } else {
      // Normal draw mode
      this.ctx.globalCompositeOperation = 'source-over';
      
      switch (state.brush) {
        case 'neon':
          // Neon Glow effect
          this.ctx.shadowColor = brushColor;
          this.ctx.shadowBlur = state.size * 1.5;
          this.ctx.strokeStyle = brushColor;
          this.ctx.lineWidth = state.size;
          this.ctx.lineCap = 'round';
          this.ctx.lineJoin = 'round';
          this.ctx.beginPath();
          this.ctx.moveTo(prev.x, prev.y);
          this.ctx.lineTo(currX, currY);
          this.ctx.stroke();
          break;

        case 'spray':
          // Spray/particle effect
          const dist = Math.hypot(currX - prev.x, currY - prev.y);
          const steps = Math.max(1, Math.floor(dist / 2));
          this.ctx.fillStyle = brushColor;
          
          for (let s = 0; s < steps; s++) {
            const t = s / steps;
            const px = prev.x + (currX - prev.x) * t;
            const py = prev.y + (currY - prev.y) * t;
            
            // Number of spray droplets scales with brush size
            const density = Math.floor(state.size * 1.5);
            for (let i = 0; i < density; i++) {
              const angle = Math.random() * Math.PI * 2;
              const radius = Math.random() * state.size * 1.3;
              const ox = Math.cos(angle) * radius;
              const oy = Math.sin(angle) * radius;
              this.ctx.fillRect(px + ox, py + oy, 1.8, 1.8);
            }
          }
          break;

        case 'calligraphy':
          // Calligraphy ribbon brush - flat 45-degree angle
          const calliAngle = -Math.PI / 4; // -45 deg
          const ox = Math.cos(calliAngle) * (state.size / 2);
          const oy = Math.sin(calliAngle) * (state.size / 2);
          
          this.ctx.fillStyle = brushColor;
          this.ctx.beginPath();
          this.ctx.moveTo(prev.x - ox, prev.y - oy);
          this.ctx.lineTo(currX - ox, currY - oy);
          this.ctx.lineTo(currX + ox, currY + oy);
          this.ctx.lineTo(prev.x + ox, prev.y + oy);
          this.ctx.closePath();
          this.ctx.fill();
          break;

        case 'normal':
        default:
          // Standard Round brush
          this.ctx.strokeStyle = brushColor;
          this.ctx.lineWidth = state.size;
          this.ctx.lineCap = 'round';
          this.ctx.lineJoin = 'round';
          this.ctx.beginPath();
          this.ctx.moveTo(prev.x, prev.y);
          this.ctx.lineTo(currX, currY);
          this.ctx.stroke();
          break;
      }
    }
    
    this.ctx.restore();

    // 5. Save point as history
    state.prevPoint = { x: currX, y: currY };
  }

  /**
   * Returns current active stroke detail (Physics utility)
   */
  getActiveStroke(handedness) {
    return {
      points: this.activeStrokePoints[handedness] || [],
      color: this.handStates[handedness].color,
      size: this.handStates[handedness].size
    };
  }

  /**
   * Exports the canvas as a downloadable PNG image.
   * If camera view is not hidden, we can draw a black background, or keep it transparent.
   * We will create a white or black background to make it print/save friendly.
   */
  exportPNG() {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this.canvas.width;
    exportCanvas.height = this.canvas.height;
    const exportCtx = exportCanvas.getContext('2d');

    // Fill with a gorgeous deep dark background
    exportCtx.fillStyle = '#070913';
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // Draw the painting layers
    exportCtx.drawImage(this.canvas, 0, 0);

    // Trigger download
    const dataUrl = exportCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `airpaint-artwork-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  }
}
