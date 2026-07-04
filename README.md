# PhobGCC Display-List Viewer

React-based browser viewer for PhobGCC controller UI display-list frames.

## Features

- **WebUSB Connection**: Connect directly to GC adapter via WebUSB (Chrome/Edge)
- **Live Display Streaming**: Read display-list from controller using 0xC0 command
- **Auto-Refresh**: Continuous monitoring of controller display updates
- **File Loading**: Load pre-recorded display-list binary files
- **Asset Rendering**: Bitmap font and RLE-encoded image support

## Setup

```bash
cd PhobGCC/rp2040/tools/display-list-viewer
npm install
npm run dev
```

## Usage

### Via WebUSB (Live Mode)

1. Click "Open Adapter (WebUSB)" and select your GC adapter (VID:0x057e PID:0x0337)
2. Select controller port (1-4)
3. Click "Read Display-List (0xC0)" to capture current frame
4. Enable "Auto-Refresh" for continuous updates (~2 Hz)

### Via File

1. Click "Or load file" and select a `.bin` or `.dl` file
2. Navigate frames and adjust scale as needed

## Architecture

- **Assets**: Font and images are pre-loaded from JSON files
- **Display-List**: Binary protocol with 7 opcodes (see displayList.js)
- **Rendering**: Canvas-based with bitmap font and RLE image support
- **React**: JSX components for UI and rendering logic
- **WebUSB**: Direct SI communication via GC adapter

## Protocol

The 0xC0 SI command reads display-list chunks (80 bytes each):
- Byte 0: Total chunks
- Byte 1: Chunk index
- Bytes 2-79: Display-list data (78 bytes payload)

## Files

- `src/App.jsx` - Main React component with WebUSB integration
- `src/bitmapFont.js` - 8×15 ASCII bitmap font renderer
- `src/rleImages.js` - RLE image decoder (5-bit run | 3-bit palette)
- `src/displayList.js` - Display-list protocol decoder
- `assets/` - Exported font and image data (JSON)

## Color Scheme

- Background: #000000
- Foreground: #ffffff
- Accent: #485CC7 (blue)
- Muted: #cfcfe0
