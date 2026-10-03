# riso separator

Herramienta web estática para separar una imagen (JPG, PNG o WebP) en capas de tinta para imprimir en risografía.

- **Talleres:** paletas de Aoi Club y Rata Estudio, con sus valores exactos de color.
- **Separación:** automática (mezcla las tintas elegidas para aproximar cada color), CMYK o RGB. Admite de 1 a 4 capas.
- **Trama:** tono continuo, halftone (circle, line, square, ellipse, cross) o dither (atkinson, floydsteinberg, bayer, none). Puede ser global o propia de cada capa. Cada capa tiene su propio ángulo para evitar el moiré.
- **Preview:** las capas se sobreimprimen con multiply sobre papel blanco. La línea gris marca el área imprimible y no se exporta.
- **Exportación a 300 dpi (A4 o A3, vertical u horizontal):**
  - `PDF color`: la primera página es la composición y luego viene una página por capa en el color de su tinta.
  - `PDF b/n`: una página por capa, donde negro = 100 % de tinta. Son los másters para la riso.
  - `PNG capas`: un PNG en escala de grises por capa.

  Solo se exportan las capas visibles. La densidad simula la intensidad de la tinta en el preview y en el PDF color. Los másters b/n y PNG no la aplican: esa intensidad se regula en la máquina.

Usa [p5.js](https://p5js.org) 1.9, [p5.riso](https://github.com/antiboredom/p5.riso) (copia local en `libs/`) y [jsPDF](https://github.com/parallax/jsPDF). No necesita build ni backend.

## Uso local

Abre la carpeta con un servidor estático, por ejemplo con la extensión Live Server de VS Code o con:

```sh
python3 -m http.server
```

Luego abre `http://localhost:8000`.

## Publicar en GitHub Pages

1. Sube el repositorio a GitHub, con `index.html` en la raíz.
2. En el repositorio, ve a **Settings → Pages**.
3. En **Build and deployment**, elige **Source: Deploy from a branch**, **Branch: `main`** y la carpeta **`/ (root)`**, y pulsa **Save**.
4. Al cabo de un minuto la herramienta queda en `https://<usuario>.github.io/<repo>/`.

Todas las rutas son relativas, así que funciona servida desde esa subruta.
