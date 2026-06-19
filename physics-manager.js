/**
 * Physics Manager for AirPaint (Kinetic Rigging Mode)
 * Powered by Matter.js. Handles dynamic ball physics, static obstacles,
 * goal detection, and converting hand-drawn strokes into rigid colliders.
 */

export class PhysicsManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    // Matter.js engine & runner aliases
    const { Engine, World, Bodies, Composite, Runner } = window.Matter;
    
    this.engine = Engine.create({
      gravity: { y: 0.85 } // Realistic gravity pull
    });
    this.world = this.engine.world;
    this.runner = Runner.create();
    
    // Game Entities
    this.ball = null;
    this.goal = { x: 0, y: 0, radius: 45 };
    this.staticObstacles = [];
    this.drawnBodies = []; // Array of arrays of Matter.js bodies (one array per stroke)
    
    // Game States
    this.score = 0;
    this.level = 1;
    this.goalTimeMs = 0; // Cumulative time ball stays inside goal
    this.winThresholdMs = 1500; // Must stay in goal for 1.5 seconds to win
    this.ballInGoal = false;
    
    // Visual settings
    this.spawner = { x: 120, y: 150 };
    
    // Particles for victory/collision effects
    this.particles = [];

    // Level Designs
    this.levelDesigns = [
      // Level 1: Simple block in the center
      () => [
        Bodies.rectangle(this.canvas.width / 2, this.canvas.height / 2 + 50, 200, 30, { isStatic: true, label: 'obstacle', angle: 0.15 })
      ],
      // Level 2: Slalom setup (offset blocking walls)
      () => [
        Bodies.rectangle(this.canvas.width * 0.35, this.canvas.height * 0.4, 250, 25, { isStatic: true, label: 'obstacle', angle: 0.1 }),
        Bodies.rectangle(this.canvas.width * 0.65, this.canvas.height * 0.65, 250, 25, { isStatic: true, label: 'obstacle', angle: -0.1 })
      ],
      // Level 3: Center corridor gate
      () => [
        Bodies.rectangle(this.canvas.width / 2 - 120, this.canvas.height * 0.5, 30, 200, { isStatic: true, label: 'obstacle' }),
        Bodies.rectangle(this.canvas.width / 2 + 120, this.canvas.height * 0.5, 30, 200, { isStatic: true, label: 'obstacle' }),
        Bodies.rectangle(this.canvas.width / 2, this.canvas.height * 0.35, 120, 20, { isStatic: true, label: 'obstacle' })
      ]
    ];
  }

  /**
   * Starts the physics simulation runner
   */
  start() {
    window.Matter.Runner.run(this.runner, this.engine);
    this.loadLevel(this.level);
    this.spawnBall();
  }

  /**
   * Stops the physics simulation runner
   */
  stop() {
    window.Matter.Runner.stop(this.runner);
    this.clearAllPhysics();
  }

  /**
   * Resets and loads a specific level's static obstacles
   */
  loadLevel(levelIndex) {
    const { World, Composite } = window.Matter;
    
    // 1. Clear existing static obstacles
    this.staticObstacles.forEach(body => World.remove(this.world, body));
    this.staticObstacles = [];
    
    // 2. Clear all user drawn ramps
    this.clearDrawnRamps();

    // 3. Compute dynamic position for Goal (always bottom right, scaled)
    this.goal.x = this.canvas.width - 150;
    this.goal.y = this.canvas.height - 150;
    this.spawner.x = 120;
    this.spawner.y = 150;

    // 4. Load designed layout
    const designIndex = (levelIndex - 1) % this.levelDesigns.length;
    const loadFunc = this.levelDesigns[designIndex];
    
    this.staticObstacles = loadFunc();
    this.staticObstacles.forEach(body => {
      body.render = { fillStyle: '#ffffff' }; // Custom rendering tag
      World.add(this.world, body);
    });

    this.goalTimeMs = 0;
    this.ballInGoal = false;
  }

  /**
   * Spawns/Respawns the player's dynamic ball
   */
  spawnBall() {
    const { World, Bodies } = window.Matter;

    // Remove old ball if exists
    if (this.ball) {
      World.remove(this.world, this.ball);
    }

    // Create dynamic circle with low friction and moderate restitution (bounciness)
    this.ball = Bodies.circle(this.spawner.x, this.spawner.y, 18, {
      restitution: 0.42,
      friction: 0.05,
      frictionAir: 0.005,
      label: 'ball'
    });

    World.add(this.world, this.ball);
    this.goalTimeMs = 0;
    this.ballInGoal = false;
    
    // Create initial spawn particles
    this.createExplosion(this.spawner.x, this.spawner.y, '#00f2fe', 12);
  }

  /**
   * Converts a user's freehand stroke (array of points) into physical Caddy colliders
   */
  addDrawnRamp(points, brushSize, strokeColor) {
    if (points.length < 2) return;

    const { World, Bodies, Body, Composite } = window.Matter;
    const thickness = Math.max(8, brushSize); // Minimum thickness for collision stability
    const strokeBodies = [];

    // Loop through points and create connecting rectangles
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const length = Math.hypot(dx, dy);

      // Skip tiny segments to optimize Matter.js engine
      if (length < 3) continue;

      const angle = Math.atan2(dy, dx);
      const midX = p1.x + dx / 2;
      const midY = p1.y + dy / 2;

      // Create static rectangular beam
      const segment = Bodies.rectangle(midX, midY, length, thickness, {
        isStatic: true,
        angle: angle,
        friction: 0.15,
        restitution: 0.2,
        label: 'player_ramp'
      });

      // Save custom styling properties for rendering
      segment.customRender = {
        p1: { x: p1.x, y: p1.y },
        p2: { x: p2.x, y: p2.y },
        color: strokeColor,
        thickness: thickness
      };

      strokeBodies.push(segment);
      World.add(this.world, segment);
    }

    if (strokeBodies.length > 0) {
      this.drawnBodies.push(strokeBodies);
    }
  }

  /**
   * Checks if user eraser is touching any drawn ramps and deletes them
   */
  eraseAt(x, y, radius) {
    const { World } = window.Matter;
    
    // Filter out bodies that overlap with eraser circle
    for (let s = this.drawnBodies.length - 1; s >= 0; s--) {
      const stroke = this.drawnBodies[s];
      let strokeModified = false;

      for (let i = stroke.length - 1; i >= 0; i--) {
        const body = stroke[i];
        const dist = Math.hypot(body.position.x - x, body.position.y - y);
        
        if (dist <= radius + 15) {
          // Trigger erase sparks
          this.createExplosion(body.position.x, body.position.y, '#ee5253', 3);
          World.remove(this.world, body);
          stroke.splice(i, 1);
          strokeModified = true;
        }
      }

      if (stroke.length === 0) {
        this.drawnBodies.splice(s, 1);
      }
    }
  }

  /**
   * Clears only user-drawn platform ramps
   */
  clearDrawnRamps() {
    const { World } = window.Matter;
    this.drawnBodies.forEach(stroke => {
      stroke.forEach(body => World.remove(this.world, body));
    });
    this.drawnBodies = [];
  }

  /**
   * Full reset of the engine
   */
  clearAllPhysics() {
    const { World } = window.Matter;
    
    if (this.ball) World.remove(this.world, this.ball);
    this.staticObstacles.forEach(body => World.remove(this.world, body));
    this.clearDrawnRamps();
    
    this.ball = null;
    this.staticObstacles = [];
    this.particles = [];
  }

  /**
   * Game loop tick logic
   */
  update(deltaTimeMs) {
    if (!this.ball) return;

    // 1. Check Out-of-Bounds (respawn ball)
    if (this.ball.position.y > this.canvas.height + 50 || 
        this.ball.position.x < -50 || 
        this.ball.position.x > this.canvas.width + 50) {
      this.spawnBall();
      return;
    }

    // 2. Goal Detection (Radial check)
    const distToGoal = Math.hypot(this.ball.position.x - this.goal.x, this.ball.position.y - this.goal.y);
    const inGoal = (distToGoal < this.goal.radius);

    if (inGoal) {
      this.ballInGoal = true;
      this.goalTimeMs += deltaTimeMs;
      
      // Spawn tiny goal vortex sparks
      if (Math.random() < 0.35) {
        this.particles.push({
          x: this.goal.x + (Math.random() - 0.5) * 40,
          y: this.goal.y + (Math.random() - 0.5) * 40,
          vx: (this.goal.x - this.ball.position.x) * 0.05,
          vy: (this.goal.y - this.ball.position.y) * 0.05,
          color: '#fffc46',
          size: Math.random() * 3 + 1,
          alpha: 1.0,
          life: 400
        });
      }

      // Check win condition
      if (this.goalTimeMs >= this.winThresholdMs) {
        this.triggerLevelVictory();
      }
    } else {
      this.ballInGoal = false;
      this.goalTimeMs = Math.max(0, this.goalTimeMs - deltaTimeMs * 1.5); // Decay timer
    }

    // 3. Update active particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= deltaTimeMs;
      p.alpha = Math.max(0, p.life / 500);

      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  /**
   * Action triggered on winning a level
   */
  triggerLevelVictory() {
    this.score += 100 * this.level;
    this.level += 1;
    
    // Spawn massive victory fireworks
    this.createExplosion(this.goal.x, this.goal.y, '#fffc46', 30);
    this.createExplosion(this.goal.x, this.goal.y, '#00f2fe', 20);
    this.createExplosion(this.goal.x, this.goal.y, '#f35588', 20);

    // Load next layout
    this.loadLevel(this.level);
    this.spawnBall();

    // Trigger window events to notify main UI
    const event = new CustomEvent('airpaint:level_win', {
      detail: { level: this.level, score: this.score }
    });
    window.dispatchEvent(event);
  }

  /**
   * Generates sparks / explosions on collision/wins
   */
  createExplosion(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 2;
      this.particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (Math.random() * 1.5), // slight upward bias
        color: color,
        size: Math.random() * 4 + 2,
        alpha: 1.0,
        life: Math.random() * 400 + 300
      });
    }
  }

  /**
   * Render function to override paint-canvas drawing
   * @param {Array} activeStrokes - List of active strokes being drawn [{ points: [], color, size }, ...]
   */
  render(activeStrokes = []) {
    const ctx = this.ctx;
    
    // 1. Clear painting canvas to redrawing physical objects in real-time
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 2. Draw Active/Drawn User platforms
    this.drawnBodies.forEach(stroke => {
      stroke.forEach(body => {
        const renderData = body.customRender;
        if (!renderData) return;

        ctx.save();
        ctx.strokeStyle = renderData.color === 'rainbow' ? '#00f2fe' : renderData.color;
        ctx.lineWidth = renderData.thickness;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        // Neon glow effect for player drawn lines
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = renderData.thickness * 1.2;

        ctx.beginPath();
        ctx.moveTo(renderData.p1.x, renderData.p1.y);
        ctx.lineTo(renderData.p2.x, renderData.p2.y);
        ctx.stroke();
        ctx.restore();
      });
    });

    // Draw active strokes currently drawing (pinching in-progress)
    activeStrokes.forEach(activeStroke => {
      if (activeStroke && activeStroke.points && activeStroke.points.length > 1) {
        ctx.save();
        ctx.strokeStyle = activeStroke.color === 'rainbow' ? '#ffffff' : activeStroke.color;
        ctx.lineWidth = activeStroke.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = activeStroke.size * 0.8;

        ctx.beginPath();
        ctx.moveTo(activeStroke.points[0].x, activeStroke.points[0].y);
        for (let i = 1; i < activeStroke.points.length; i++) {
          ctx.lineTo(activeStroke.points[i].x, activeStroke.points[i].y);
        }
        ctx.stroke();
        ctx.restore();
      }
    });

    // 3. Draw Static Level Obstacles (Glass-Neon design)
    this.staticObstacles.forEach(body => {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 12;

      // Draw oriented rectangle
      ctx.beginPath();
      const vertices = body.vertices;
      ctx.moveTo(vertices[0].x, vertices[0].y);
      for (let j = 1; j < vertices.length; j++) {
        ctx.lineTo(vertices[j].x, vertices[j].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    // 4. Draw Goal Portal
    ctx.save();
    const portalHue = (performance.now() / 8) % 360;
    const mainColor = `hsl(${portalHue}, 100%, 60%)`;
    
    // Outer rotating neon boundary
    ctx.beginPath();
    ctx.arc(this.goal.x, this.goal.y, this.goal.radius, 0, Math.PI * 2);
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 4;
    ctx.shadowColor = mainColor;
    ctx.shadowBlur = 20;
    ctx.stroke();

    // Inner holographic target rings
    ctx.beginPath();
    ctx.arc(this.goal.x, this.goal.y, this.goal.radius - 12, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.setLineDash([8, 6]);
    ctx.stroke();

    // Portal energy fill core
    const pulseFactor = 0.85 + Math.sin(performance.now() / 150) * 0.15;
    const gradient = ctx.createRadialGradient(
      this.goal.x, this.goal.y, 5,
      this.goal.x, this.goal.y, this.goal.radius * pulseFactor
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
    gradient.addColorStop(0.3, `hsla(${portalHue}, 100%, 60%, 0.3)`);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    
    ctx.beginPath();
    ctx.arc(this.goal.x, this.goal.y, this.goal.radius * pulseFactor, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();

    // 5. Draw Spawner Ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.spawner.x, this.spawner.y, 25, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 242, 254, 0.3)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.arc(this.spawner.x, this.spawner.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#00f2fe';
    ctx.fill();
    ctx.restore();

    // 6. Draw Player Dynamic Ball
    if (this.ball) {
      const pos = this.ball.position;
      const radius = this.ball.circleRadius || 18;

      ctx.save();
      // Glowing body gradient
      const ballGrad = ctx.createRadialGradient(
        pos.x - radius * 0.2, pos.y - radius * 0.2, 2,
        pos.x, pos.y, radius
      );
      ballGrad.addColorStop(0, '#ffffff');
      ballGrad.addColorStop(0.4, '#00f2fe');
      ballGrad.addColorStop(1, '#0575e6');

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = ballGrad;
      
      // Neon glow
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = this.ballInGoal ? 30 : 15;
      ctx.fill();
      ctx.restore();
    }

    // 7. Draw Active Particles
    ctx.save();
    this.particles.forEach(p => {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
}
