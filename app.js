/**
 * AirPaint Main Application Coordinator
 * Integrates MediaPipe Tasks Vision, Gesture Detection, Canvas Manager, and Air UI.
 */

import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';
import { GestureDetector } from './gesture-detector.js';
import { CanvasManager } from './canvas-manager.js';
import { PhysicsManager } from './physics-manager.js';

// Configuration
const HOVER_TRIGGER_MS = 1000; // Time needed to hover over a button to "click" it

// Hand connections index mapping for skeleton drawing
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
  [5, 6], [6, 7], [7, 8],          // Index
  [9, 10], [10, 11], [11, 12],     // Middle
  [13, 14], [14, 15], [15, 16],    // Ring
  [17, 18], [18, 19], [19, 20],    // Pinky
  [0, 5], [5, 9], [9, 13], [13, 17], [0, 17] // Palm
];

class AirPaintApp {
  constructor() {
    this.video = document.getElementById('webcam');
    this.paintCanvas = document.getElementById('paint-canvas');
    this.skeletonCanvas = document.getElementById('skeleton-canvas');
    this.skeletonCtx = this.skeletonCanvas.getContext('2d');

    // UI Status elements
    this.statusModel = document.getElementById('status-model');
    this.statusCamera = document.getElementById('status-camera');

    // Managers & Detectors
    this.canvasManager = new CanvasManager(this.paintCanvas);
    this.gestureDetector = new GestureDetector();
    this.physicsManager = new PhysicsManager(this.paintCanvas);
    
    // Application States
    this.handLandmarker = null;
    this.isStreaming = false;
    this.lastVideoTime = -1;
    this.lastTime = performance.now();
    this.gameMode = 'art'; // 'art' or 'game'

    // Track state transitions to capture undo states on start of stroke
    this.wasDrawing = {
      'Left': false,
      'Right': false
    };

    // Air UI Hover Tracking state for each hand
    this.hoverStates = {
      'Left': { button: null, startTime: 0, triggered: false },
      'Right': { button: null, startTime: 0, triggered: false }
    };

    // Mouse Fallback state
    this.isMouseDown = false;

    // Initialize
    this.init();
  }

  /**
   * Application Initializer
   */
  async init() {
    // 1. Setup window resize listener
    window.addEventListener('resize', () => {
      this.canvasManager.resize();
      this.resizeSkeletonCanvas();
    });
    this.resizeSkeletonCanvas();

    // 2. Bind traditional UI events (mouse clicks)
    this.bindUIEvents();
    this.bindGameEvents();
    this.bindMouseEvents();

    // 3. Initialize MediaPipe HandLandmarker
    try {
      this.updateModelStatus('loading', 'Cargando IA...');
      await this.initHandLandmarker();
      this.updateModelStatus('online', 'MediaPipe IA Lista');
      this.showToast('✅ Modelo de IA cargado con éxito.', 'success');
    } catch (err) {
      this.updateModelStatus('offline', 'Error de Carga');
      this.showToast('❌ Error al cargar modelo de IA.', 'error');
      console.error(err);
      return;
    }

    // 4. Start Webcam & Camera Loop
    try {
      await this.setupWebcam();
      this.isStreaming = true;
      this.updateCameraStatus('online', 'Cámara Activa');
      this.showToast('📷 Cámara activada. ¡Listo para pintar!', 'info');
    } catch (err) {
      this.updateCameraStatus('offline', 'Cámara no disponible');
      console.warn('Camera failed, enabling mouse-only fallback loop:', err);
      this.isStreaming = true; // Enable loop to run anyway for mouse fallbacks
      this.showToast('⚠️ Cámara bloqueada. Usa el ratón/táctil para pintar.', 'warning');
    }

    // Begin the detection and render loop
    window.requestAnimationFrame((time) => this.loop(time));
  }

  /**
   * Resizes skeletal overlay canvas to match viewport
   */
  resizeSkeletonCanvas() {
    this.skeletonCanvas.width = window.innerWidth;
    this.skeletonCanvas.height = window.innerHeight;
  }

  /**
   * Initializes FilesetResolver and HandLandmarker
   */
  async initHandLandmarker() {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    
    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 2
      });
    } catch (gpuError) {
      console.warn('GPU acceleration initialization failed, falling back to CPU mode:', gpuError);
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numHands: 2
      });
    }
  }

  /**
   * Request user webcam permissions and mount stream
   */
  async setupWebcam() {
    const constraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      },
      audio: false
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.warn('La cámara falló con resolución alta. Intentando configuración básica...', err);
      // Fallback a video básico sin forzar resolución
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    this.video.srcObject = stream;
    
    return new Promise((resolve) => {
      this.video.onloadedmetadata = () => {
        this.video.play();
        resolve(this.video);
      };
    });
  }

  /**
   * Core execution loop (runs on requestAnimationFrame)
   */
  loop(timestamp) {
    if (!this.isStreaming) return;

    // Calculate frame delta time
    const now = performance.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    // Run hand landmarker inference if a new video frame is available
    if (this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      
      try {
        const results = this.handLandmarker.detectForVideo(this.video, timestamp);
        
        // Render skeletons, cursors, paths, and Air UI
        this.processFrame(results, dt);
      } catch (err) {
        console.error('Error running detection: ', err);
      }
    } else if (this.gameMode === 'game') {
      // If camera frame hasn't updated but we are in physics mode, we still need 
      // to step simulation and draw active strokes at 60 FPS.
      this.physicsManager.update(dt);
      
      const activeStrokes = [
        this.canvasManager.getActiveStroke('Left'),
        this.canvasManager.getActiveStroke('Right')
      ];
      this.physicsManager.render(activeStrokes);
      
      // Update timer feedback in UI
      if (this.physicsManager.ballInGoal) {
        const sec = (this.physicsManager.goalTimeMs / 1000).toFixed(1);
        document.getElementById('game-timer').innerText = `${sec}s`;
      } else {
        document.getElementById('game-timer').innerText = '0.0s';
      }
    }

    window.requestAnimationFrame((time) => this.loop(time));
  }

  /**
   * Process results and draw elements on screen
   */
  processFrame(results, dt) {
    // 1. Clear skeletal canvas layer
    this.skeletonCtx.clearRect(0, 0, this.skeletonCanvas.width, this.skeletonCanvas.height);

    // Active tracking status tracking
    const detectedHands = {
      'Left': false,
      'Right': false
    };

    if (results && results.landmarks && results.landmarks.length > 0) {
      // Process each detected hand
      for (let i = 0; i < results.landmarks.length; i++) {
        const landmarks = results.landmarks[i];
        
        // MediaPipe handedness represents camera view.
        // E.g. results.handednesses[i][0].categoryName is "Left" or "Right"
        const handedness = results.handednesses[i][0].categoryName;
        detectedHands[handedness] = true;

        // Display hand info pill
        this.updateHandPill(handedness, true);

        // A. Classify hand gesture
        const { gesture, activePoint } = this.gestureDetector.detectGesture(landmarks);
        
        // B. Convert coordinates to screen pixels for cursor & Air UI
        let screenX = 0;
        let screenY = 0;
        if (activePoint) {
          // Adjust for video's object-fit: cover cropping to keep cursor aligned
          const videoRatio = this.video.videoWidth / this.video.videoHeight;
          const screenRatio = this.skeletonCanvas.width / this.skeletonCanvas.height;
          
          let renderWidth = this.skeletonCanvas.width;
          let renderHeight = this.skeletonCanvas.height;
          let offsetX = 0;
          let offsetY = 0;
          
          if (videoRatio > 0 && screenRatio > 0) {
            if (screenRatio > videoRatio) {
              renderHeight = this.skeletonCanvas.width / videoRatio;
              offsetY = (this.skeletonCanvas.height - renderHeight) / 2;
            } else {
              renderWidth = this.skeletonCanvas.height * videoRatio;
              offsetX = (this.skeletonCanvas.width - renderWidth) / 2;
            }
          }

          screenX = (1.0 - activePoint.x) * renderWidth + offsetX;
          screenY = activePoint.y * renderHeight + offsetY;
        }

        // C. Stroke State Change Checking: Save history state on draw start
        const isDrawing = (gesture === 'DRAW' || gesture === 'ERASE');
        if (isDrawing && !this.wasDrawing[handedness]) {
          // Save canvas snapshot before starting a new stroke (if in classic Art Mode)
          if (this.gameMode === 'art') {
            this.canvasManager.saveHistoryState();
          }
        }
        
        // Physics Mode Transition Action: If released the pinch (drawing stopped), turn line into physics body
        if (!isDrawing && this.wasDrawing[handedness] && this.gameMode === 'game') {
          const activeStroke = this.canvasManager.getActiveStroke(handedness);
          if (activeStroke && activeStroke.points.length > 1) {
            this.physicsManager.addDrawnRamp(activeStroke.points, activeStroke.size, activeStroke.color);
          }
        }
        
        this.wasDrawing[handedness] = isDrawing;

        // D. Draw stroke paths
        if (isDrawing && activePoint) {
          if (gesture === 'ERASE' && this.gameMode === 'game') {
            // In physics mode, eraser deletes colliders
            const state = this.canvasManager.handStates[handedness];
            this.physicsManager.eraseAt(screenX, screenY, state.size * 2.5 / 2);
          } else {
            this.canvasManager.draw(handedness, gesture, { x: screenX, y: screenY });
          }
        } else {
          // Reset previous line anchor points when not drawing
          this.canvasManager.resetHandTrack(handedness);
        }

        // E. Air UI Button Hover processing (only if not drawing or erasing)
        if (!isDrawing && activePoint) {
          this.processAirUIHover(handedness, screenX, screenY);
        } else {
          this.resetAirUIHover(handedness);
        }

        // F. Draw skeletal overlay on canvas
        this.drawSkeleton(landmarks, handedness);

        // G. Draw brush cursor indicator at index finger tip
        this.drawCursor(screenX, screenY, handedness, gesture);
      }
    }

    // Hide pills of hands not visible in current frame
    for (const handedness of ['Left', 'Right']) {
      if (!detectedHands[handedness]) {
        // If hand is lost while drawing, convert lines to physics body
        if (this.wasDrawing[handedness] && this.gameMode === 'game') {
          const activeStroke = this.canvasManager.getActiveStroke(handedness);
          if (activeStroke && activeStroke.points.length > 1) {
            this.physicsManager.addDrawnRamp(activeStroke.points, activeStroke.size, activeStroke.color);
          }
        }
        
        this.updateHandPill(handedness, false);
        this.resetAirUIHover(handedness);
        this.canvasManager.resetHandTrack(handedness);
        this.wasDrawing[handedness] = false;
      }
    }

    // Render Physics layer in real-time if in Game Mode
    if (this.gameMode === 'game') {
      this.physicsManager.update(dt);
      
      const activeStrokes = [
        this.canvasManager.getActiveStroke('Left'),
        this.canvasManager.getActiveStroke('Right')
      ];
      this.physicsManager.render(activeStrokes);
      
      // Update HUD timer
      if (this.physicsManager.ballInGoal) {
        const sec = (this.physicsManager.goalTimeMs / 1000).toFixed(1);
        document.getElementById('game-timer').innerText = `${sec}s`;
      } else {
        document.getElementById('game-timer').innerText = '0.0s';
      }
    }
  }

  /**
   * Processes Air UI hover interactions
   */
  processAirUIHover(handedness, screenX, screenY) {
    const hoverState = this.hoverStates[handedness];
    const elements = document.querySelectorAll('.air-btn');
    let hoveredElement = null;

    // Check if cursor point lies inside any button rect
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom) {
        hoveredElement = el;
        break;
      }
    }

    const currentTime = performance.now();

    if (hoveredElement) {
      if (hoverState.button === hoveredElement) {
        // Still hovering same button
        if (!hoverState.triggered) {
          const elapsed = currentTime - hoverState.startTime;
          
          // Draw circular progress indicator around cursor
          const progress = Math.min(1.0, elapsed / HOVER_TRIGGER_MS);
          this.drawProgressRing(screenX, screenY, progress, handedness);

          if (elapsed >= HOVER_TRIGGER_MS) {
            // Click button!
            hoverState.triggered = true;
            this.triggerAirUIAction(hoveredElement, handedness);
          }
        }
      } else {
        // Entered a different button
        hoverState.button = hoveredElement;
        hoverState.startTime = currentTime;
        hoverState.triggered = false;
      }
    } else {
      // Off UI buttons
      this.resetAirUIHover(handedness);
    }
  }

  /**
   * Reset Air UI hover state for a hand
   */
  resetAirUIHover(handedness) {
    const hoverState = this.hoverStates[handedness];
    hoverState.button = null;
    hoverState.startTime = 0;
    hoverState.triggered = false;
  }

  /**
   * Simulates clicking of Air UI elements
   */
  triggerAirUIAction(element, handedness) {
    // Add active feedback visual class
    element.classList.add('active-air-click');
    setTimeout(() => element.classList.remove('active-air-click'), 400);

    // Call click handler on the element or process directly
    if (element.classList.contains('color-preset')) {
      const color = element.dataset.color;
      this.canvasManager.setHandColor(handedness, color);
      
      // Update UI active buttons for this color
      this.updateColorSelectionUI(element, color);
      this.showToast(`🎨 Color cambiado (${color === 'rainbow' ? 'Arcoíris' : color}) para mano ${handedness === 'Left' ? 'Izquierda' : 'Derecha'}`, 'info');
    } 
    else if (element.classList.contains('brush-preset')) {
      const brush = element.dataset.brush;
      this.canvasManager.setHandBrush(handedness, brush);
      
      this.updateBrushSelectionUI(element, brush);
      this.showToast(`✏️ Pincel cambiado a ${brush.toUpperCase()} para mano ${handedness === 'Left' ? 'Izquierda' : 'Derecha'}`, 'info');
    } 
    else if (element.classList.contains('size-preset')) {
      const size = parseInt(element.dataset.size);
      this.canvasManager.setHandSize(handedness, size);
      
      this.updateSizeSelectionUI(element, size);
      this.showToast(`📐 Pincel redimensionado a ${size}px`, 'info');
    } 
    else {
      // It's a standard button (Undo, Redo, Clear, Save, Close Tutorial)
      element.click();
    }
  }

  /**
   * Draws progress ring visualizer for Air UI hovers
   */
  drawProgressRing(x, y, progress, handedness) {
    const state = this.canvasManager.handStates[handedness];
    let strokeColor = state.color;
    if (strokeColor === 'rainbow') {
      strokeColor = '#00f2fe';
    }

    this.skeletonCtx.save();
    this.skeletonCtx.beginPath();
    
    // Radial glow
    this.skeletonCtx.shadowColor = strokeColor;
    this.skeletonCtx.shadowBlur = 10;
    
    // Draw arc loader
    this.skeletonCtx.arc(x, y, 22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    this.skeletonCtx.strokeStyle = strokeColor;
    this.skeletonCtx.lineWidth = 4;
    this.skeletonCtx.stroke();
    
    this.skeletonCtx.restore();
  }

  /**
   * Draws pointer cursor on skeleton layer
   */
  drawCursor(x, y, handedness, gesture) {
    const state = this.canvasManager.handStates[handedness];
    let cursorColor = state.color;
    if (cursorColor === 'rainbow') {
      const hue = (performance.now() / 12) % 360;
      cursorColor = `hsl(${hue}, 100%, 55%)`;
    }

    this.skeletonCtx.save();
    this.skeletonCtx.beginPath();

    if (gesture === 'DRAW') {
      // Pinching: Draw solid core indicator
      this.skeletonCtx.arc(x, y, state.size / 2 + 2, 0, Math.PI * 2);
      this.skeletonCtx.fillStyle = cursorColor;
      this.skeletonCtx.shadowColor = cursorColor;
      this.skeletonCtx.shadowBlur = 10;
      this.skeletonCtx.fill();
    } 
    else if (gesture === 'ERASE') {
      // Eraser: Draw a larger dashed circle demonstrating eraser boundaries
      this.skeletonCtx.arc(x, y, state.size * 2.5 / 2, 0, Math.PI * 2);
      this.skeletonCtx.strokeStyle = '#ffffff';
      this.skeletonCtx.lineWidth = 2;
      this.skeletonCtx.setLineDash([5, 3]);
      this.skeletonCtx.stroke();
      
      // Eraser center dot
      this.skeletonCtx.beginPath();
      this.skeletonCtx.arc(x, y, 3, 0, Math.PI * 2);
      this.skeletonCtx.fillStyle = '#ee5253';
      this.skeletonCtx.fill();
    } 
    else {
      // Hovering/Menu select: Hollow ring representing the cursor
      this.skeletonCtx.arc(x, y, 12, 0, Math.PI * 2);
      this.skeletonCtx.strokeStyle = cursorColor;
      this.skeletonCtx.lineWidth = 2.5;
      this.skeletonCtx.stroke();

      // Hollow inner dot
      this.skeletonCtx.beginPath();
      this.skeletonCtx.arc(x, y, 3, 0, Math.PI * 2);
      this.skeletonCtx.fillStyle = cursorColor;
      this.skeletonCtx.fill();
    }

    this.skeletonCtx.restore();
  }

  /**
   * Renders the hand bone connections and joint landmarks
   */
  drawSkeleton(landmarks, handedness) {
    const isLeft = (handedness === 'Left');
    const colorTheme = isLeft ? 'rgba(243, 85, 136, 0.4)' : 'rgba(0, 242, 254, 0.4)';
    const jointColor = isLeft ? '#f35588' : '#00f2fe';

    this.skeletonCtx.save();

    // 1. Draw connecting bones
    this.skeletonCtx.strokeStyle = colorTheme;
    this.skeletonCtx.lineWidth = 3.5;
    this.skeletonCtx.lineCap = 'round';
    
    for (const connection of HAND_CONNECTIONS) {
      const pt1 = landmarks[connection[0]];
      const pt2 = landmarks[connection[1]];
      
      const x1 = (1.0 - pt1.x) * this.skeletonCanvas.width;
      const y1 = pt1.y * this.skeletonCanvas.height;
      const x2 = (1.0 - pt2.x) * this.skeletonCanvas.width;
      const y2 = pt2.y * this.skeletonCanvas.height;

      this.skeletonCtx.beginPath();
      this.skeletonCtx.moveTo(x1, y1);
      this.skeletonCtx.lineTo(x2, y2);
      this.skeletonCtx.stroke();
    }

    // 2. Draw joints
    this.skeletonCtx.fillStyle = jointColor;
    for (const lm of landmarks) {
      const x = (1.0 - lm.x) * this.skeletonCanvas.width;
      const y = lm.y * this.skeletonCanvas.height;
      
      this.skeletonCtx.beginPath();
      this.skeletonCtx.arc(x, y, 4.5, 0, Math.PI * 2);
      this.skeletonCtx.fill();
    }

    this.skeletonCtx.restore();
  }

  /**
   * Binds UI Click handlers for mouse/touch interactions
   */
  bindUIEvents() {
    // 1. Tutorial Close Button
    const closeTutBtn = document.getElementById('close-tutorial-btn');
    const tutorialOverlay = document.getElementById('tutorial-overlay');
    closeTutBtn.addEventListener('click', () => {
      tutorialOverlay.classList.add('hidden');
      this.showToast('¡Modo de dibujo activado!', 'success');
    });

    const closeGameTutBtn = document.getElementById('close-game-tutorial-btn');
    const gameTutorialOverlay = document.getElementById('game-tutorial-overlay');
    if (closeGameTutBtn) {
      closeGameTutBtn.addEventListener('click', () => {
        gameTutorialOverlay.classList.add('hidden');
        this.showToast('¡A construir!', 'success');
      });
    }

    // Panel Toggle Events
    const panelToggleBtn = document.getElementById('panel-toggle-btn');
    const panelCloseBtn = document.getElementById('panel-close-btn');
    const controlPanel = document.getElementById('control-panel');

    if (panelToggleBtn && panelCloseBtn && controlPanel) {
      panelToggleBtn.addEventListener('click', () => {
        controlPanel.classList.remove('collapsed');
        panelToggleBtn.classList.add('hidden');
      });

      panelCloseBtn.addEventListener('click', () => {
        controlPanel.classList.add('collapsed');
        panelToggleBtn.classList.remove('hidden');
      });
    }

    // 2. Color picker Preset click
    const colors = document.querySelectorAll('.color-preset');
    colors.forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        // Default mouse clicks modify RIGHT hand config
        this.canvasManager.setHandColor('Right', color);
        this.updateColorSelectionUI(btn, color);
      });
    });

    // 3. Brush presets click
    const brushes = document.querySelectorAll('.brush-preset');
    brushes.forEach(btn => {
      btn.addEventListener('click', () => {
        const brush = btn.dataset.brush;
        this.canvasManager.setHandBrush('Right', brush);
        this.updateBrushSelectionUI(btn, brush);
      });
    });

    // 4. Size presets click
    const sizes = document.querySelectorAll('.size-preset');
    sizes.forEach(btn => {
      btn.addEventListener('click', () => {
        const size = parseInt(btn.dataset.size);
        this.canvasManager.setHandSize('Right', size);
        this.updateSizeSelectionUI(btn, size);
      });
    });

    // 5. Action buttons click (Undo, Redo, Clear, Save)
    document.getElementById('btn-undo').addEventListener('click', () => {
      const success = this.canvasManager.undo();
      if (success) {
        this.showToast('↩️ Deshacer completado', 'info');
      } else {
        this.showToast('⚠️ No hay más historial para deshacer', 'warning');
      }
    });

    document.getElementById('btn-redo').addEventListener('click', () => {
      const success = this.canvasManager.redo();
      if (success) {
        this.showToast('↪️ Rehacer completado', 'info');
      } else {
        this.showToast('⚠️ No hay más estados para rehacer', 'warning');
      }
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      this.canvasManager.clear();
      this.showToast('🗑️ Lienzo limpio', 'warning');
    });

    document.getElementById('btn-save').addEventListener('click', () => {
      this.canvasManager.exportPNG();
      this.showToast('💾 Arte exportado como PNG', 'success');
    });

    // 6. Camera View Modes selection
    const camViewBtns = document.querySelectorAll('.cam-view-btn');
    camViewBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetMode = btn.dataset.mode;
        
        // Remove active state and classes
        camViewBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Apply class to body
        document.body.className = '';
        document.body.classList.add(targetMode);
        
        this.showToast(`📷 Modo de cámara: ${btn.innerText}`, 'info');
        
        // Delay canvas adjustment slightly to allow layout transition to settle
        setTimeout(() => {
          this.canvasManager.resize();
          this.resizeSkeletonCanvas();
        }, 100);
      });
    });
  }

  /**
   * Binds Game events (mode switcher, respawns, window events)
   */
  bindGameEvents() {
    const btnArt = document.getElementById('btn-mode-art');
    const btnGame = document.getElementById('btn-mode-game');
    const gamePanel = document.getElementById('game-status-panel');

    btnArt.addEventListener('click', () => {
      if (this.gameMode === 'art') return;
      this.gameMode = 'art';
      
      btnArt.classList.add('active');
      btnGame.classList.remove('active');
      gamePanel.style.display = 'none';

      // Reset managers
      this.canvasManager.physicsMode = false;
      this.physicsManager.stop();
      this.canvasManager.clear();
      
      this.showToast('🎨 Modo Arte activado: Dibujo libre', 'success');
    });

    btnGame.addEventListener('click', () => {
      if (this.gameMode === 'game') return;
      this.gameMode = 'game';
      
      btnGame.classList.add('active');
      btnArt.classList.remove('active');
      gamePanel.style.display = 'flex';

      // Initialize physics engine
      this.canvasManager.physicsMode = true;
      this.canvasManager.clear();
      this.physicsManager.start();
      
      const gameTutorialOverlay = document.getElementById('game-tutorial-overlay');
      if (gameTutorialOverlay) {
        gameTutorialOverlay.classList.remove('hidden');
      }

      this.showToast('🕹️ Modo Física activado: ¡Dibuja rampas!', 'success');
    });

    document.getElementById('btn-reset-ball').addEventListener('click', () => {
      if (this.gameMode === 'game') {
        this.physicsManager.spawnBall();
        this.showToast('🔄 Bola reaparecida en origen', 'info');
      }
    });

    // Capture custom victory levels events
    window.addEventListener('airpaint:level_win', (e) => {
      document.getElementById('game-score').innerText = e.detail.score;
      document.getElementById('game-timer').innerText = '0.0s';
      this.showToast(`🎉 ¡Nivel Completado! Avanzas a Nivel ${e.detail.level}`, 'success');
    });
  }

  /**
   * Binds physical mouse fallback events for local drawing testing
   */
  bindMouseEvents() {
    window.addEventListener('mousedown', (e) => {
      // Don't draw if click is inside UI panels
      if (e.target.closest('.control-panel') || 
          e.target.closest('.app-header') || 
          e.target.closest('#tutorial-overlay') || 
          e.target.closest('#game-status-panel')) {
        return;
      }
      this.isMouseDown = true;
      const x = e.clientX;
      const y = e.clientY;
      
      if (this.gameMode === 'art') {
        this.canvasManager.saveHistoryState();
        this.canvasManager.draw('Right', 'DRAW', { x, y });
      } else {
        this.canvasManager.resetHandTrack('Right');
        this.canvasManager.draw('Right', 'DRAW', { x, y });
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isMouseDown) return;
      const x = e.clientX;
      const y = e.clientY;
      this.canvasManager.draw('Right', 'DRAW', { x, y });
    });

    window.addEventListener('mouseup', () => {
      if (!this.isMouseDown) return;
      this.isMouseDown = false;
      
      if (this.gameMode === 'game') {
        const activeStroke = this.canvasManager.getActiveStroke('Right');
        if (activeStroke && activeStroke.points.length > 1) {
          this.physicsManager.addDrawnRamp(activeStroke.points, activeStroke.size, activeStroke.color);
        }
      }
      this.canvasManager.resetHandTrack('Right');
    });
  }

  /**
   * Helper functions to update UI elements selection states
   */
  updateColorSelectionUI(activeElement, color) {
    document.querySelectorAll('.color-preset').forEach(b => b.classList.remove('active'));
    activeElement.classList.add('active');
  }

  updateBrushSelectionUI(activeElement, brush) {
    document.querySelectorAll('.brush-preset').forEach(b => b.classList.remove('active'));
    activeElement.classList.add('active');
  }

  updateSizeSelectionUI(activeElement, size) {
    document.querySelectorAll('.size-preset').forEach(b => b.classList.remove('active'));
    activeElement.classList.add('active');
    document.getElementById('brush-size-val').innerText = `${size}px`;
  }

  /**
   * Updates floating overlay pill showing hand active brush styles
   */
  updateHandPill(handedness, visible) {
    const isLeft = (handedness === 'Left');
    const pill = document.getElementById(isLeft ? 'left-hand-pill' : 'right-hand-pill');
    
    if (!pill) return;

    if (visible) {
      pill.style.display = 'flex';
      
      // Update preview dot color
      const state = this.canvasManager.handStates[handedness];
      const preview = pill.querySelector('.hand-brush-preview');
      
      if (state.color === 'rainbow') {
        preview.style.background = 'linear-gradient(45deg, red, yellow, green, blue, purple)';
      } else {
        preview.style.background = state.color;
      }
    } else {
      pill.style.display = 'none';
    }
  }

  /**
   * Status indicators updating
   */
  updateModelStatus(className, text) {
    this.statusModel.className = `status-pill ${className}`;
    this.statusModel.querySelector('.text').innerText = text;
  }

  updateCameraStatus(className, text) {
    this.statusCamera.className = `status-pill ${className}`;
    this.statusCamera.querySelector('.text').innerText = text;
  }

  /**
   * Standard custom toast message delivery
   */
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'warning') icon = '⚠️';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `<span>${icon} ${message}</span>`;
    container.appendChild(toast);
    
    // Smooth exit
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
}

// Instantiate the App
window.addEventListener('DOMContentLoaded', () => {
  window.appInstance = new AirPaintApp();
});
