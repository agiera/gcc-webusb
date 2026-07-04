/**
 * Bitmap font renderer for the 8x15 PhobGCC font
 */

let fontData = null;
let fontAtlas = null;

export async function loadFont(fontJsonPath) {
  const response = await fetch(fontJsonPath);
  fontData = await response.json();
  
  // Pre-render font atlas for faster drawing
  fontAtlas = createFontAtlas(fontData);
  return fontData;
}

function createFontAtlas(font) {
  const canvas = document.createElement('canvas');
  const glyphsPerRow = 16;
  const rows = Math.ceil(font.glyphs.length / glyphsPerRow);
  
  canvas.width = glyphsPerRow * font.width;
  canvas.height = rows * font.height;
  
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  
  font.glyphs.forEach((glyph, idx) => {
    const col = idx % glyphsPerRow;
    const row = Math.floor(idx / glyphsPerRow);
    const x = col * font.width;
    const y = row * font.height;
    
    // Draw glyph bitmap
    glyph.forEach((rowByte, rowIdx) => {
      for (let bit = 0; bit < 8; bit++) {
        if (rowByte & (0x80 >> bit)) {
          ctx.fillRect(x + bit, y + rowIdx, 1, 1);
        }
      }
    });
  });
  
  return canvas;
}

export function drawBitmapText(ctx, x, y, text, color, scale = 1, pixelScale = 1) {
  if (!fontData) {
    console.warn('Font not loaded');
    return;
  }

  const { width, height, firstChar, glyphs } = fontData;
  const px = scale * pixelScale;

  ctx.fillStyle = color;

  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    if (charCode < firstChar || charCode >= firstChar + glyphs.length) {
      continue;
    }
    const glyph = glyphs[charCode - firstChar];
    const baseX = (x + i * width * scale) * pixelScale;
    const baseY = y * pixelScale;

    for (let row = 0; row < height; row++) {
      const rowByte = glyph[row] || 0;
      if (rowByte === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (rowByte & (0x80 >> bit)) {
          ctx.fillRect(baseX + bit * px, baseY + row * px, px, px);
        }
      }
    }
  }
}

function colorToFilter(hexColor) {
  return `hue-rotate(0deg) brightness(1)`;
}
