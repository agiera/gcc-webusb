const OPCODES = {
  BEGIN_FRAME: 0x01,
  IMAGE_REF: 0x12,
  END_FRAME: 0x7f,
  // Logical (post-decode) opcodes for colored ops. NOT the wire byte; wire
  // encoding is 0x80 | (color<<3) | sub. We assign these arbitrary IDs so
  // dispatch (op.op === OPCODES.LINE) keeps working in the renderer.
  CLEAR: 0x100,
  FILL_ROWS: 0x101,
  LINE: 0x102,
  STRING: 0x103,
  HLINE: 0x104,
  VLINE: 0x105,
};

// Wire sub-op (low 3 bits when high bit is set) -> logical opcode.
const COLORED_SUB_TO_OP = {
  0: OPCODES.CLEAR,
  1: OPCODES.FILL_ROWS,
  2: OPCODES.LINE,
  3: OPCODES.STRING,
  4: OPCODES.HLINE,
  5: OPCODES.VLINE,
};

export const OPCODE_NAMES = {
  [OPCODES.BEGIN_FRAME]: 'BEGIN_FRAME',
  [OPCODES.CLEAR]: 'CLEAR',
  [OPCODES.FILL_ROWS]: 'FILL_ROWS',
  [OPCODES.LINE]: 'LINE',
  [OPCODES.STRING]: 'STRING',
  [OPCODES.HLINE]: 'HLINE',
  [OPCODES.VLINE]: 'VLINE',
  [OPCODES.IMAGE_REF]: 'IMAGE_REF',
  [OPCODES.END_FRAME]: 'END_FRAME',
};

const DEFAULT_PALETTE = [
  "#000000", "#111111", "#222222", "#333333",
  "#444444", "#000000", "#552200", "#884400",
  "#aa0000", "#cc2200", "#ee7700", "#ffaa00",
  "#cccccc", "#dddddd", "#eeeeee", "#ffffff",
];

function readU8(view, state) {
  const value = view.getUint8(state.offset);
  state.offset += 1;
  return value;
}

function readU16(view, state) {
  const value = view.getUint16(state.offset, true);
  state.offset += 2;
  return value;
}

function readU32(view, state) {
  const value = view.getUint32(state.offset, true);
  state.offset += 4;
  return value;
}

function readAscii(view, state, length) {
  const chars = [];
  for (let i = 0; i < length; i += 1) {
    chars.push(String.fromCharCode(readU8(view, state)));
  }
  return chars.join("");
}

function colorFromIndex(index, palette) {
  const safe = index & 0x0f;
  return palette[safe] || "#ff00ff";
}

function drawLine(ctx, x0, y0, x1, y1, color, scale) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, scale);
  ctx.beginPath();
  ctx.moveTo(x0 * scale + 0.5, y0 * scale + 0.5);
  ctx.lineTo(x1 * scale + 0.5, y1 * scale + 0.5);
  ctx.stroke();
}

function drawString(ctx, x, y, color, scaleGlyph, text, pixelScale) {
  const fontSize = 14 * scaleGlyph * pixelScale;
  ctx.fillStyle = color;
  ctx.font = `${fontSize}px monospace`;
  ctx.textBaseline = "top";
  ctx.fillText(text, x * pixelScale, y * pixelScale);
}

function drawImagePlaceholder(ctx, x, y, width, height, imageId, pixelScale) {
  const px = x * pixelScale;
  const py = y * pixelScale;
  const pw = width * pixelScale;
  const ph = height * pixelScale;

  ctx.strokeStyle = "#00c2ff";
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, pw, ph);

  ctx.fillStyle = "rgba(0, 194, 255, 0.15)";
  ctx.fillRect(px, py, pw, ph);

  ctx.fillStyle = "#00c2ff";
  ctx.font = `${10 * pixelScale}px monospace`;
  ctx.textBaseline = "top";
  ctx.fillText(`img:${imageId.toString(16)}`, px + 2, py + 2);
}

export function decodeDisplayList(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const state = { offset: 0 };

  const frames = [];

  while (state.offset < view.byteLength) {
    const opcode = readU8(view, state);
    // Trailing zero bytes are padding from the fixed-size SI chunk transfer.
    if (opcode === 0x00) {
      break;
    }
    if (opcode !== OPCODES.BEGIN_FRAME) {
      throw new Error(`Expected BEGIN_FRAME at byte ${state.offset - 1}, got 0x${opcode.toString(16)}`);
    }

    const frame = {
      frameId: readU32(view, state),
      width: readU16(view, state),
      height: readU16(view, state),
      redrawType: readU8(view, state),
      droppedOps: 0,
      ops: [],
      // Per-opcode byte breakdown { 0x10: { count, bytes }, ... }
      opStats: {},
    };
    // BEGIN_FRAME consumed 10 bytes (opcode + 4+2+2+1)
    frame.opStats[OPCODES.BEGIN_FRAME] = { count: 1, bytes: 10 };

    while (state.offset < view.byteLength) {
      const opByteStart = state.offset;
      const wire = readU8(view, state);

      // Uncolored opcodes.
      if ((wire & 0x80) === 0) {
        if (wire === OPCODES.END_FRAME) {
          frame.droppedOps = readU16(view, state);
          const bytes = state.offset - opByteStart;
          const s = (frame.opStats[OPCODES.END_FRAME] ||= { count: 0, bytes: 0 });
          s.count += 1; s.bytes += bytes;
          break;
        }

        if (wire === OPCODES.IMAGE_REF) {
          frame.ops.push({
            op: OPCODES.IMAGE_REF,
            x: readU16(view, state),
            y: readU16(view, state),
            width: readU16(view, state),
            height: readU16(view, state),
            imageId: readU32(view, state),
          });
          const bytes = state.offset - opByteStart;
          const s = (frame.opStats[OPCODES.IMAGE_REF] ||= { count: 0, bytes: 0 });
          s.count += 1; s.bytes += bytes;
          continue;
        }

        throw new Error(`Unknown opcode 0x${wire.toString(16)} at byte ${opByteStart}`);
      }

      // Colored op: high bit set, color in bits 6..3, sub in bits 2..0.
      const color = (wire >> 3) & 0x0f;
      const sub = wire & 0x07;
      const op = COLORED_SUB_TO_OP[sub];
      if (op === undefined) {
        throw new Error(`Unknown colored sub 0x${sub.toString(16)} at byte ${opByteStart}`);
      }

      if (op === OPCODES.CLEAR) {
        frame.ops.push({ op, color });
      } else if (op === OPCODES.FILL_ROWS) {
        frame.ops.push({
          op,
          color,
          y: readU16(view, state),
          rows: readU16(view, state),
        });
      } else if (op === OPCODES.LINE) {
        frame.ops.push({
          op,
          color,
          x0: readU16(view, state),
          y0: readU16(view, state),
          x1: readU16(view, state),
          y1: readU16(view, state),
        });
      } else if (op === OPCODES.HLINE) {
        const y = readU16(view, state);
        const x0 = readU16(view, state);
        const x1 = readU16(view, state);
        frame.ops.push({ op, color, x0, y0: y, x1, y1: y });
      } else if (op === OPCODES.VLINE) {
        const x = readU16(view, state);
        const y0 = readU16(view, state);
        const y1 = readU16(view, state);
        frame.ops.push({ op, color, x0: x, y0, x1: x, y1 });
      } else if (op === OPCODES.STRING) {
        const x = readU16(view, state);
        const y = readU16(view, state);
        const scale = readU8(view, state);
        const len = readU8(view, state);
        const text = readAscii(view, state, len);
        frame.ops.push({ op, x, y, color, scale, text });
      }

      const bytes = state.offset - opByteStart;
      const s = (frame.opStats[op] ||= { count: 0, bytes: 0 });
      s.count += 1; s.bytes += bytes;
    }

    frames.push(frame);
  }

  return frames;
}

export function replayDisplayList(canvas, frames, options = {}) {
  if (!frames.length) {
    throw new Error("No frames found in display-list payload");
  }

  const palette = options.palette || DEFAULT_PALETTE;
  const frameIndex = options.frameIndex || 0;
  const pixelScale = Math.max(1, options.pixelScale || 1);

  const frame = frames[Math.min(frameIndex, frames.length - 1)];
  const ctx = canvas.getContext("2d");

  canvas.width = frame.width * pixelScale;
  canvas.height = frame.height * pixelScale;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  for (const op of frame.ops) {
    if (op.op === OPCODES.CLEAR) {
      ctx.fillStyle = colorFromIndex(op.color, palette);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      continue;
    }

    if (op.op === OPCODES.FILL_ROWS) {
      ctx.fillStyle = colorFromIndex(op.color, palette);
      ctx.fillRect(0, op.y * pixelScale, canvas.width, op.rows * pixelScale);
      continue;
    }

    if (op.op === OPCODES.LINE || op.op === OPCODES.HLINE || op.op === OPCODES.VLINE) {
      drawLine(
        ctx,
        op.x0,
        op.y0,
        op.x1,
        op.y1,
        colorFromIndex(op.color, palette),
        pixelScale
      );
      continue;
    }

    if (op.op === OPCODES.STRING) {
      drawString(
        ctx,
        op.x,
        op.y,
        colorFromIndex(op.color, palette),
        op.scale,
        op.text,
        pixelScale
      );
      continue;
    }

    if (op.op === OPCODES.IMAGE_REF) {
      drawImagePlaceholder(
        ctx,
        op.x,
        op.y,
        op.width,
        op.height,
        op.imageId,
        pixelScale
      );
    }
  }

  return frame;
}
