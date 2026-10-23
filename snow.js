const container = document.getElementById('snow-container');
const snowBuildUpCanvas = document.getElementById('snow-build-up');
const ctx = snowBuildUpCanvas.getContext('2d');
const snowflakes = [];

snowBuildUpCanvas.width = container.offsetWidth;
snowBuildUpCanvas.height = container.offsetHeight;

const snowLevels = new Array(snowBuildUpCanvas.width).fill(0);
const maxSnowDepth = 40; // Limit snow depth to 100px

const snowflakeCharacters = ['❄', '*', '❉', '❃', '❅'];

let snowflakeCounter = 0; // Counter to throttle snowflake creation
let snowflakeCreationRate;
let isMelting = false; // Flag for melting phase

// Determine creation rate based on screen size
if (window.innerWidth > 768) {
  snowflakeCreationRate = 3; // More snowflakes on desktop
} else {
  snowflakeCreationRate = 8; // Fewer snowflakes on mobile
}

let lastFrameTime = performance.now();

function createSnowflake() {
  const snowflake = {
    x: Math.random() * snowBuildUpCanvas.width,
    y: -10,
    size: Math.random() * 10 + 5, // Adjust size to make the symbols more visible
    speed: Math.random() * 1 + .4,
    opacity: .5, // Initial opacity
    character: snowflakeCharacters[Math.floor(Math.random() * snowflakeCharacters.length)] // Random snowflake character
  };
  snowflakes.push(snowflake);
}

function smoothAccumulation() {
  // Smooth out the snow accumulation over time by averaging snow levels
  for (let i = 1; i < snowLevels.length - 1; i++) {
    snowLevels[i] = (snowLevels[i - 1] + snowLevels[i] + snowLevels[i + 1]) / 3;
  }
}

function drawSnowflakes(deltaTime) {
  ctx.clearRect(0, 0, snowBuildUpCanvas.width, snowBuildUpCanvas.height);

  // Draw buildup
  ctx.fillStyle = 'white';
  for (let x = 0; x < snowLevels.length; x++) {
    ctx.fillRect(x, snowBuildUpCanvas.height - snowLevels[x], 1, snowLevels[x]);
  }

  // Draw falling snowflakes
  ctx.fillStyle = 'white';
  snowflakes.forEach((snowflake, index) => {
    ctx.globalAlpha = snowflake.opacity; // Apply opacity to the snowflake
    ctx.font = `${snowflake.size}px sans-serif`; // Set the font size for the snowflake character
    ctx.fillText(snowflake.character, snowflake.x, snowflake.y); // Draw the snowflake character
    ctx.globalAlpha = 1; // Reset alpha

    if (!isMelting) {
      snowflake.y += snowflake.speed * deltaTime * 60; // Adjust speed by deltaTime
    } else {
      snowflake.speed *= 0.98; // Slow down snowflake
      snowflake.opacity *= 0.98; // Fade out snowflake
    }

    // If snowflake reaches the bottom, accumulate snow
    if (
      snowflake.y + snowflake.size / 5 >=
      snowBuildUpCanvas.height - snowLevels[Math.floor(snowflake.x)]
    ) {
      if (!isMelting) {
        const snowflakeX = Math.floor(snowflake.x);
        const snowflakeSize = snowflake.size / 2;

        // Accumulate snow more smoothly across a range with a weighted falloff effect
        const accumulationWidth = Math.ceil(snowflakeSize * 2);
        for (let i = -accumulationWidth; i <= accumulationWidth; i++) {
          const xIndex = Math.min(Math.max(snowflakeX + i, 0), snowLevels.length - 1);
          const distance = Math.abs(i); // The distance from the center of the snowflake
          const falloff = Math.exp(-distance / 50); // smoother Gaussian
// Gaussian falloff (smooth transition)

          // Apply the falloff to the accumulation to smooth the edges
          if (snowLevels[xIndex] < maxSnowDepth) {
            snowLevels[xIndex] += snowflake.size / 4 * falloff*.05; // Quicker accumulation with smoothing
          }
        }

        // Remove snowflake once it lands
        snowflakes.splice(index, 1);
      }
    }
  });

  // Apply smoothing after every update
  smoothAccumulation();
}

function meltSnow() {
  let allMelted = true;
  for (let i = 0; i < snowLevels.length; i++) {
    if (snowLevels[i] > 0) {
      const meltRate = Math.random() * 0.3 + 0.1; // Varying melt rates for uneven melting
      snowLevels[i] -= meltRate; // Melt snow gradually
      if (snowLevels[i] < 0) snowLevels[i] = 0; // Prevent negative values
      allMelted = false;
    }
  }

  // Introduce additional random offsets to simulate flow and uneven melting
  for (let i = 0; i < snowLevels.length; i++) {
    if (i > 0 && i < snowLevels.length - 1) {
      const leftNeighbor = snowLevels[i - 1];
      const rightNeighbor = snowLevels[i + 1];
      const average = (leftNeighbor + rightNeighbor) / 2;

      // Adjust current level slightly toward the average of neighbors
      const adjustment = (average - snowLevels[i]) * 0.2;
      snowLevels[i] += adjustment;
    }
  }

  return allMelted;
}

function checkFullSnow() {
  return snowLevels.every(level => level >= maxSnowDepth);
}

function animate() {
  const currentTime = performance.now();
  const deltaTime = (currentTime - lastFrameTime) / 1000; // Time elapsed in seconds
  lastFrameTime = currentTime;

  if (!isMelting) {
    if (checkFullSnow()) {
      isMelting = true; // Start melting phase
    } else if (snowflakeCounter % snowflakeCreationRate === 0) {
      createSnowflake();
    }
    snowflakeCounter++;
  } else {
    if (meltSnow()) {
      // Reset state when snow is fully melted
      snowflakes.length = 0; // Clear all snowflakes
      snowLevels.fill(0); // Reset snow levels
      isMelting = false;
    }
  }

  drawSnowflakes(deltaTime);
  requestAnimationFrame(animate);
}

animate();