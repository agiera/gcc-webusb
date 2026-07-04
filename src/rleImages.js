/**
 * RLE image decoder for PhobGCC images
 */

let imageData = null;
const imageCache = new Map();

export async function loadImages(imagesJsonPath) {
  const response = await fetch(imagesJsonPath);
  imageData = await response.json();
  return imageData;
}

export function decodeRLEImage(imageName, palette) {
  if (!imageData || !imageData[imageName]) {
    console.warn(`Image not found: ${imageName}`);
    return null;
  }
  
  // Check cache
  const cacheKey = `${imageName}`;
  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }
  
  const img = imageData[imageName];
  const data = img.data;
  const paletteIndices = img.paletteIndices;
  
  // First 4 bytes: width (u16 BE), height (u16 BE)
  const width = (data[0] << 8) | data[1];
  const height = (data[2] << 8) | data[3];
  
  // Decode RLE
  const pixels = new Uint8Array(width * height);
  let pixelIdx = 0;
  let byteIdx = 4;
  
  while (byteIdx < data.length && pixelIdx < pixels.length) {
    const runByte = data[byteIdx++];
    const runLength = (runByte >> 3) + 1;
    const colorIdx = runByte & 0x07;
    const paletteValue = paletteIndices[colorIdx];
    
    for (let i = 0; i < runLength && pixelIdx < pixels.length; i++) {
      pixels[pixelIdx++] = paletteValue;
    }
  }
  
  // Create ImageData
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageDataObj = ctx.createImageData(width, height);
  
  for (let i = 0; i < pixels.length; i++) {
    const paletteIdx = pixels[i];
    const color = palette[paletteIdx] || '#000000';
    const rgb = hexToRgb(color);
    
    const idx4 = i * 4;
    imageDataObj.data[idx4] = rgb.r;
    imageDataObj.data[idx4 + 1] = rgb.g;
    imageDataObj.data[idx4 + 2] = rgb.b;
    // Palette indices < 5 are transparent (per firmware spec)
    imageDataObj.data[idx4 + 3] = paletteIdx < 5 ? 0 : 255;
  }
  
  ctx.putImageData(imageDataObj, 0, 0);
  
  const result = { canvas, width, height };
  imageCache.set(cacheKey, result);
  return result;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}
