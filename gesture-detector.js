/**
 * Gesture Detector for AirPaint
 * Tracks and classifies 3D hand landmarks into drawing actions.
 */

export class GestureDetector {
  constructor() {
    // Thresholds scaled by palm size
    this.PINCH_THRESHOLD = 0.55; // Normalized index-thumb distance (increased for easier pinching)
    this.ERASER_INDEX_MIDDLE_THRESHOLD = 0.35; // Max distance between index & middle tips for erasing
    this.FINGER_FOLD_THRESHOLD_FACTOR = 0.85; // Factor of MCP-PIP distance for folding
  }

  /**
   * Helper to calculate Euclidean distance between two 3D landmarks
   */
  getDistance(p1, p2) {
    if (!p1 || !p2) return 999;
    return Math.sqrt(
      Math.pow(p1.x - p2.x, 2) +
      Math.pow(p1.y - p2.y, 2) +
      Math.pow(p1.z - p2.z, 2)
    );
  }

  /**
   * Analyzes landmarks to detect if fingers are extended or folded.
   * Returns an object indicating extension state of each finger.
   */
  detectFingerStates(landmarks, palmSize) {
    const wrist = landmarks[0];
    
    // Check if fingers are extended relative to their MCP (base) joints
    // MediaPipe Y coordinates decrease as we move UP (smaller Y is higher).
    // So if Tip.y < PIP.y, the finger is pointing up/extended.
    
    // Index (base: 5, pip: 6, dip: 7, tip: 8)
    const indexExtended = this.getDistance(landmarks[8], wrist) > this.getDistance(landmarks[6], wrist);
    
    // Middle (base: 9, pip: 10, dip: 11, tip: 12)
    const middleExtended = this.getDistance(landmarks[12], wrist) > this.getDistance(landmarks[10], wrist);
    
    // Ring (base: 13, pip: 14, dip: 15, tip: 16)
    const ringExtended = this.getDistance(landmarks[16], wrist) > this.getDistance(landmarks[14], wrist);
    
    // Pinky (base: 17, pip: 18, dip: 19, tip: 20)
    const pinkyExtended = this.getDistance(landmarks[20], wrist) > this.getDistance(landmarks[18], wrist);

    // Thumb (base: 1, mcp: 2, ip: 3, tip: 4)
    // Thumb is trickier since it moves horizontally. Check distance between thumb tip and index MCP.
    const thumbExtended = this.getDistance(landmarks[4], landmarks[9]) > (palmSize * 0.95);

    return {
      thumb: thumbExtended,
      index: indexExtended,
      middle: middleExtended,
      ring: ringExtended,
      pinky: pinkyExtended
    };
  }

  /**
   * Detect and classify gesture from hand landmarks
   * @param {Array} landmarks - Array of 21 landmarks
   * @returns {Object} { gestureName: string, activePoint: {x, y, z}, isDrawing: boolean }
   */
  detectGesture(landmarks) {
    if (!landmarks || landmarks.length < 21) {
      return { gestureName: 'NONE', activePoint: null, isDrawing: false };
    }

    const wrist = landmarks[0];
    const indexMcp = landmarks[5];
    const indexTip = landmarks[8];
    const thumbTip = landmarks[4];
    const middleTip = landmarks[12];
    
    // Palm size: reference length to normalize distances
    const palmSize = this.getDistance(wrist, indexMcp);

    // 1. Calculate critical distances
    const thumbIndexDistance = this.getDistance(thumbTip, indexTip);
    const indexMiddleDistance = this.getDistance(indexTip, middleTip);

    const normalizedPinch = thumbIndexDistance / palmSize;
    const normalizedIndexMiddle = indexMiddleDistance / palmSize;

    // 2. Analyze finger extensions
    const fingers = this.detectFingerStates(landmarks, palmSize);

    // Active tracking point is the tip of the index finger
    const activePoint = {
      x: indexTip.x,
      y: indexTip.y,
      z: indexTip.z
    };

    // 3. Gesture decision tree
    
    // A. Pinch to Draw: Index and Thumb are touching
    if (normalizedPinch < this.PINCH_THRESHOLD) {
      return {
        gesture: 'DRAW',
        activePoint,
        isDrawing: true,
        debugData: { normalizedPinch }
      };
    }

    // B. Eraser Mode: Index and Middle finger are extended and close together, others closed
    if (fingers.index && fingers.middle && !fingers.ring && !fingers.pinky && 
        normalizedIndexMiddle < this.ERASER_INDEX_MIDDLE_THRESHOLD) {
      // Use midpoint between index and middle tip as the eraser coordinates
      const eraserPoint = {
        x: (indexTip.x + middleTip.x) / 2,
        y: (indexTip.y + middleTip.y) / 2,
        z: (indexTip.z + middleTip.z) / 2
      };
      return {
        gesture: 'ERASE',
        activePoint: eraserPoint,
        isDrawing: true, // Eraser acts as "drawing" in terms of drawing-loops
        debugData: { normalizedIndexMiddle }
      };
    }

    // C. Open Palm: All fingers extended -> Hover / Mode Switch / Navigation (No draw)
    const activeFingersCount = Object.values(fingers).filter(Boolean).length;
    if (activeFingersCount >= 4) {
      return {
        gesture: 'OPEN_HAND',
        activePoint,
        isDrawing: false,
        debugData: { activeFingersCount }
      };
    }

    // D. Closed Fist: All fingers folded -> Grab / Pause / Static (No draw)
    if (activeFingersCount <= 1 && !fingers.index) {
      return {
        gesture: 'FIST',
        activePoint: null,
        isDrawing: false,
        debugData: { activeFingersCount }
      };
    }

    // E. Default: Cursor mode (Hover). Index finger is open, others might be closed/ignored.
    return {
      gesture: 'HOVER',
      activePoint,
      isDrawing: false,
      debugData: { fingers, normalizedPinch }
    };
  }
}
