# image to riso tool

Herramienta web estática para separar una imagen (JPG, PNG o WebP) en capas de tinta para imprimir en risografía.

- **Proyecto:** póster (una imagen) o fanzine de 8 páginas en una sola hoja. En fanzine se suben varias imágenes (o un PDF, que se reparte en páginas) y se ordenan a mano arrastrándolas o haciendo clic en dos para intercambiarlas; las que sobran quedan en una bandeja. La hoja se impone sola (fila de arriba invertida: 5 4 3 2, abajo: 6 7 8 1), siempre en horizontal: A4 da páginas A7 y A3 da páginas A6. La preview marca los dobleces (azul) y el corte (rosa), que no se exportan.
- **Flipbook:** se sube un video, se marca el tramo y cuántos frames sacar (repartidos parejo) y se reparten en hojas A4/A3 con márgenes ajustables en cada tarjeta: X (franja para encuadernar a la izquierda) e Y (arriba y abajo del frame). Las marcas de corte (0,1 mm, por fuera de la grilla, para guillotina) y el número de cada frame se imprimen en una sola tinta, sólida y en registro (por defecto la más oscura). Con varias hojas, los PDF se ordenan por tambor: todas las hojas de la tinta 1, luego las de la tinta 2…
- **Talleres:** paletas de Aoi Club, Rata Estudio y Lab360 UDP, con sus valores exactos de color.
- **Separación:** automática (mezcla las tintas elegidas para aproximar cada color, priorizando el tono), CMYK o RGB. Admite de 1 a 4 capas.
- **Cuentagotas:** toma un color de la imagen y mándalo a una tinta (o al papel, para quitarlo). Esa zona se imprime en tinta sólida, sin mezclas, en cualquier modo de separación. Cada regla tiene su tolerancia, con borde suave.
- **Trama:** tono continuo, halftone (circle, line, square, ellipse, cross) o dither (atkinson, floydsteinberg, bayer, none). Puede ser global o propia de cada capa. Cada capa tiene su propio ángulo para evitar el moiré.
- **Preview:** las capas se sobreimprimen con multiply sobre papel blanco. La línea gris marca el área imprimible y no se exporta.
- **Página:** A4 o A3, vertical u horizontal. *Contener* muestra la imagen completa; *rellenar* cubre toda el área imprimible y recorta lo que sobra.
- **Exportación a 300 dpi:**
  - `PDF color`: la primera página es la composición y luego viene una página por capa en el color de su tinta.
  - `PDF b/n`: una página por capa, donde negro = 100 % de tinta. Son los másters para la riso.
  - `PNG color`: un PNG con la composición, como saldría impresa.
  - `PNG capas`: un PNG en escala de grises por capa.

  Solo se exportan las capas visibles. La densidad simula la intensidad de la tinta en el preview y en el PDF color. Los másters b/n y PNG no la aplican: esa intensidad se regula en la máquina.

En teléfono la interfaz muestra un paso a la vez con una barra de pestañas abajo y la preview arriba (zoom con dos dedos); en tablet el panel queda al costado. En pantallas táctiles los controles son más grandes.

Usa [p5.js](https://p5js.org) 1.9, [p5.riso](https://github.com/antiboredom/p5.riso) (copia local en `js/vendor/`) y [jsPDF](https://github.com/parallax/jsPDF). No necesita build ni backend.

## Estructura

```
index.html
favicon.svg          favicon estático (brand.js lo anima)
img/og-image.png     miniatura para compartir el link (fuente: img/og-banner.html)
css/style.css        interfaz
js/brand.js          favicon animado
js/inks.js           tintas de cada taller
js/separation.js     color → cobertura de tinta (modos auto y cmyk)
js/sketch.js         preview, tramas, exportación e interfaz
js/zine.js           fanzine de 8 páginas: imposición, orden de páginas y guías
js/flip.js           flipbook: video → frames, hojas, marcas de corte y números
js/recolor.js        cuentagotas: reemplazar un color por una tinta o el papel
js/zoom.js           zoom y desplazamiento de la preview (rueda, trackpad o dos dedos)
js/mobile.js         teléfono: un paso a la vez con barra de pestañas
js/vendor/p5.riso.js
```

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
