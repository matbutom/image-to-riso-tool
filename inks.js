/*
  inks.js — ink catalogue per print workshop.
  Always use these hex values (not the p5.riso colour names): some workshop
  inks share a name with a library colour but not its exact RGB.
*/

const WORKSHOPS = {
  aoi: {
    name: "aoi club",
    // Default ink order used when creating layers
    defaults: ["medium-blue", "fluorescent-pink", "yellow", "black"],
    inks: [
      { slug: "yellow", name: "Yellow", hex: "#FFE800" },
      { slug: "fluorescent-pink", name: "Fluorescent Pink", hex: "#FF48B0" },
      { slug: "green", name: "Green", hex: "#00A95C" },
      { slug: "red", name: "Red", hex: "#F15060" },
      { slug: "black", name: "Black", hex: "#000000" },
      { slug: "medium-blue", name: "Medium Blue", hex: "#3255A4" },
    ],
  },
  rata: {
    name: "rata estudio",
    defaults: ["azul", "rosa-fluor", "amarillo", "negro"],
    inks: [
      { slug: "negro", name: "Negro", hex: "#000000" },
      { slug: "rojo-scarlet", name: "Rojo (Scarlet)", hex: "#F65058" },
      { slug: "azul", name: "Azul", hex: "#0078BF" },
      { slug: "amarillo", name: "Amarillo", hex: "#FFE800" },
      { slug: "rosa-fluor", name: "Rosa flúor", hex: "#FF48B0" },
      { slug: "turquesa-claro", name: "Turquesa claro (Light Teal)", hex: "#009DA5" },
      { slug: "verde-kelly", name: "Verde (Kelly Green)", hex: "#67B346" },
      { slug: "naranja-melon", name: "Naranja (Melón)", hex: "#FFAE3B" },
    ],
  },
};

// Precompute [r, g, b] arrays from hex so sketch.js can pass them to new Riso()
Object.values(WORKSHOPS).forEach((ws) => {
  ws.inks.forEach((ink) => {
    const n = parseInt(ink.hex.slice(1), 16);
    ink.rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
});

window.WORKSHOPS = WORKSHOPS;
