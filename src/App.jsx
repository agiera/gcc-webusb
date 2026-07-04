import React, { useState, useEffect, useRef } from 'react';
import { decodeDisplayList, OPCODE_NAMES } from './displayList';
import { loadFont, drawBitmapText } from './bitmapFont';
import { loadImages, decodeRLEImage } from './rleImages';

const ADAPTER_VID = 0x057e;
const ADAPTER_PID = 0x0337;
// Display-list chunk sizing — must match firmware
// (rp2040/src/joybus.cpp DISPLAY_LIST_CHUNK_*).
const DISPLAY_LIST_CHUNK_DATA_SIZE = 510;
const DISPLAY_LIST_CHUNK_TRANSFER_SIZE = 512;
// Adapter wire protocol (1KB-capable):
//   OUT  request 10: [cmd, port, cmd_len_lo, cmd_len_hi, resp_len_lo, resp_len_hi, ...cmd]
//   IN   request 11: [cmd, port, resp_len_lo, resp_len_hi, ...response]
const MAX_RAW_PAYLOAD = 1024;
const CMD_HEADER_LEN = 6;
const RESP_HEADER_LEN = 4;

// Metadata transfer protocol (must match PhobGCC firmware)
const METADATA_TRANSFER_SIZE = 80;
const METADATA_MAX_CHUNKS = 8;
const METADATA_CHUNK_DATA_SIZE = METADATA_TRANSFER_SIZE - 2;
const METADATA_MAX_BYTES = METADATA_MAX_CHUNKS * METADATA_CHUNK_DATA_SIZE;

// Minimal UBJSON encoder/decoder for flat string-valued objects
function ubjsonEncode(obj) {
  const parts = [];
  parts.push(0x7B); // '{'
  const enc = new TextEncoder();
  for (const [key, val] of Object.entries(obj)) {
    const kBytes = enc.encode(key);
    parts.push(0x69); // 'i' = int8 length
    parts.push(kBytes.length & 0xFF);
    for (const b of kBytes) parts.push(b);
    const vBytes = enc.encode(val);
    parts.push(0x53); // 'S'
    if (vBytes.length < 128) {
      parts.push(0x69);
      parts.push(vBytes.length & 0xFF);
    } else {
      parts.push(0x49); // 'I' = int16
      parts.push((vBytes.length >> 8) & 0xFF);
      parts.push(vBytes.length & 0xFF);
    }
    for (const b of vBytes) parts.push(b);
  }
  parts.push(0x7D); // '}'
  return new Uint8Array(parts);
}

function ubjsonDecode(buf) {
  const dec = new TextDecoder();
  let pos = 0;
  function readLen() {
    const t = buf[pos++];
    if (t === 0x69) return buf[pos++];
    if (t === 0x55) return buf[pos++];
    if (t === 0x49) { const v = (buf[pos] << 8) | buf[pos + 1]; pos += 2; return v; }
    if (t === 0x6C) { const v = (buf[pos] << 24) | (buf[pos+1] << 16) | (buf[pos+2] << 8) | buf[pos+3]; pos += 4; return v; }
    throw new Error('Unsupported length type: 0x' + t.toString(16));
  }
  function readValue() {
    const t = buf[pos++];
    if (t === 0x53) { const len = readLen(); const s = dec.decode(buf.slice(pos, pos + len)); pos += len; return s; }
    if (t === 0x5A) return null;
    if (t === 0x69) return buf[pos++];
    throw new Error('Unsupported value type: 0x' + t.toString(16));
  }
  if (buf[pos++] !== 0x7B) throw new Error('Expected object start');
  const obj = {};
  while (pos < buf.length && buf[pos] !== 0x7D) {
    const keyLen = readLen();
    const key = dec.decode(buf.slice(pos, pos + keyLen));
    pos += keyLen;
    obj[key] = readValue();
  }
  return obj;
}

const OPCODES = {
  BEGIN_FRAME: 0x01,
  IMAGE_REF: 0x12,
  END_FRAME: 0x7f,
  // Logical (post-decode) IDs for colored ops; see displayList.js.
  CLEAR: 0x100,
  FILL_ROWS: 0x101,
  LINE: 0x102,
  STRING: 0x103,
  HLINE: 0x104,
  VLINE: 0x105,
};

// Stable image IDs assigned by the firmware. Must match enum ImageId in
// rp2040/include/cvideo.h. Keys are u32 values; values are the asset names
// used in assets/images.json.
const IMAGE_ID_TO_NAME = {
  1: 'Cute_Ghost',
  2: 'deadzone',
  3: 'await',
  4: 'movewait',
  5: 'crouch',
  6: 'ledgeL',
  7: 'ledgeR',
};

const DEFAULT_PALETTE = [
  '#000000', '#111111', '#222222', '#333333',
  '#444444', '#000000', '#552200', '#884400',
  '#aa0000', '#cc2200', '#ee7700', '#ffaa00',
  '#cccccc', '#dddddd', '#eeeeee', '#ffffff',
];

export default function App() {
  const canvasRef = useRef(null);
  const staticRafRef = useRef(null);
  const [displayActive, setDisplayActive] = useState(false);
  const [frames, setFrames] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [meta, setMeta] = useState('');
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [usbDevice, setUsbDevice] = useState(null);
  const [controller, setController] = useState(1);
  const [log, setLog] = useState([]);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const [fps, setFps] = useState({ fps: 0, transfersPerSec: 0, chunksPerFrame: 0, bytesPerFrame: 0 });
  const fpsAccumRef = useRef({ frames: 0, transfers: 0, bytes: 0, lastChunks: 0, t0: performance.now(), outMs: 0, inMs: 0, polls: 0 });
  const metaLockRef = useRef(false); // kept only for setControllerMetadata guard
  const usbMutexRef = useRef(Promise.resolve());

  function withUsbLock(fn) {
    let release;
    const next = new Promise(r => { release = r; });
    const result = usbMutexRef.current.then(() => fn()).finally(() => release());
    usbMutexRef.current = next;
    return result;
  }
  const [metaName, setMetaName] = useState('');
  const [metaNametag, setMetaNametag] = useState('');
  const [metaSlippi, setMetaSlippi] = useState('');
  const [metaSmashGG, setMetaSmashGG] = useState('');
  const [metaParryGG, setMetaParryGG] = useState('');
  const [metaFirmware, setMetaFirmware] = useState('');
  const [metaAvailable, setMetaAvailable] = useState(false);
  const lastPolledMetaRef = useRef(null);

  useEffect(() => {
    // Load assets on mount
    Promise.all([
      loadFont('./assets/font.json'),
      loadImages('./assets/images.json')
    ]).then(() => {
      setAssetsLoaded(true);
      console.log('✓ Assets loaded');
    }).catch(err => {
      console.error('Failed to load assets:', err);
    });
  }, []);

  function addLog(msg, level = '') {
    setLog(l => [{ msg, level, ts: Date.now() }, ...l].slice(0, 100));
    console.log(msg);
    if (level === 'error' || level === 'success') {
      setToast({ msg, level });
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToast(null), 4000);
    }
  }

  async function openWebUSB() {
    if (!('usb' in navigator)) {
      addLog('WebUSB not available', 'error');
      return;
    }
    try {
      const dev = await navigator.usb.requestDevice({
        filters: [{ vendorId: ADAPTER_VID, productId: ADAPTER_PID, interfaceClass: 0xFF }]
      });
      await dev.open();
      await dev.selectConfiguration(1);
      await dev.claimInterface(1);
      setUsbDevice(dev);
      addLog('Opened WebUSB: ' + (dev.productName || `${dev.vendorId}:${dev.productId}`));
    } catch (e) {
      addLog('Open failed: ' + e, 'error');
    }
  }

  async function closeWebUSB() {
    if (!usbDevice) return;
    try {
      await usbDevice.releaseInterface(1);
      await usbDevice.close();
    } catch (e) {}
    setUsbDevice(null);
    addLog('Closed WebUSB');
  }

  async function joybusTransfer(port, cmdBytes, { maxRespLen = MAX_RAW_PAYLOAD, timeoutMs = 500 } = {}) {
    if (!usbDevice) throw new Error('No device');
    const cmdLen = Math.min(cmdBytes.length, MAX_RAW_PAYLOAD);
    const respLen = Math.min(maxRespLen, MAX_RAW_PAYLOAD);
    const pkt = new Uint8Array(CMD_HEADER_LEN + cmdLen);
    pkt[0] = 0x02;             // WEBUSB_CMD_JOYBUS_CMD
    pkt[1] = port;
    pkt[2] = cmdLen & 0xff;    // cmd_len LE
    pkt[3] = (cmdLen >> 8) & 0xff;
    pkt[4] = respLen & 0xff;   // resp_len LE
    pkt[5] = (respLen >> 8) & 0xff;
    pkt.set(cmdBytes.slice(0, cmdLen), CMD_HEADER_LEN);
    const tOut0 = performance.now();
    await usbDevice.controlTransferOut({
      requestType: 'vendor',
      recipient: 'interface',
      request: 10,
      value: 0,
      index: 1
    }, pkt);
    const tOut1 = performance.now();
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    while (Date.now() < deadline) {
      pollCount += 1;
      const res = await usbDevice.controlTransferIn({
        requestType: 'vendor',
        recipient: 'interface',
        request: 11,
        value: 0,
        index: 1
      }, RESP_HEADER_LEN + respLen);
      if (res.data && res.data.byteLength > 0) {
        const data = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
        if (data[0] !== 0x02 || data.length < RESP_HEADER_LEN) throw new Error('Unexpected response');
        const rxLen = Math.min(data[2] | (data[3] << 8), data.length - RESP_HEADER_LEN);
        const tIn1 = performance.now();
        joybusTransfer.lastTiming = {
          outMs: tOut1 - tOut0,
          inMs: tIn1 - tOut1,
          polls: pollCount,
        };
        return data.slice(RESP_HEADER_LEN, RESP_HEADER_LEN + rxLen);
      }
      // Poll again immediately; the adapter answers within ~1 ms when ready.
      await new Promise(r => setTimeout(r, 0));
    }
    throw new Error('timeout');
  }

  async function readDisplayList({ quiet = false } = {}) {
    if (!usbDevice) {
      if (!quiet) addLog('Open adapter first', 'error');
      return 'error';
    }
    if (!assetsLoaded) {
      if (!quiet) addLog('Assets not loaded yet', 'error');
      return 'error';
    }
    const port = (controller - 1) & 0x3;
    try {
      const first = await joybusTransfer(port, new Uint8Array([0xC0, 0x00]), {
        maxRespLen: DISPLAY_LIST_CHUNK_TRANSFER_SIZE
      });
      // Accumulate per-transfer timing
      {
        const t = joybusTransfer.lastTiming;
        if (t) {
          const a = fpsAccumRef.current;
          a.outMs += t.outMs; a.inMs += t.inMs; a.polls += t.polls;
        }
      }
      const totalChunks = first[0];
      if (!quiet) {
        const hexDump = (arr, n = 16) => Array.from(arr.slice(0, n)).map(b => b.toString(16).padStart(2,'0')).join(' ');
        addLog(`Chunk0 resp: ${first.length}B hdr=[${hexDump(first, 2)}] data=[${hexDump(first.slice(2))}…]`);
        addLog(`Display-list chunks: ${totalChunks}`);
      }
      const chunks = [first.slice(2)];
      for (let i = 1; i < totalChunks; i++) {
        const resp = await joybusTransfer(port, new Uint8Array([0xC0, i]), {
          maxRespLen: DISPLAY_LIST_CHUNK_TRANSFER_SIZE
        });
        const t = joybusTransfer.lastTiming;
        if (t) {
          const a = fpsAccumRef.current;
          a.outMs += t.outMs; a.inMs += t.inMs; a.polls += t.polls;
        }
        chunks.push(resp.slice(2));
      }
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const raw = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        raw.set(c, off);
        off += c.length;
      }
      // FPS / throughput accounting
      {
        const a = fpsAccumRef.current;
        a.frames += 1;
        a.transfers += chunks.length; // 1 control transfer per chunk
        a.bytes += totalLen;
        a.lastChunks = chunks.length;
        // Actual display-list size = position of last non-zero byte + 1.
        // Trailing zeros are SI chunk padding, so this tells us the
        // smallest chunk size that would still fit this frame in 1 chunk.
        let actualLen = raw.length;
        while (actualLen > 0 && raw[actualLen - 1] === 0) actualLen--;
        a.lastActualBytes = actualLen;
        if (actualLen > (a.peakActualBytes || 0)) a.peakActualBytes = actualLen;
        const now = performance.now();
        const dt = now - a.t0;
        if (dt >= 500) {
          setFps({
            fps: (a.frames * 1000) / dt,
            transfersPerSec: (a.transfers * 1000) / dt,
            chunksPerFrame: a.lastChunks,
            bytesPerFrame: totalLen,
            actualBytesPerFrame: a.lastActualBytes,
            peakActualBytes: a.peakActualBytes,
            avgOutMs: a.transfers ? a.outMs / a.transfers : 0,
            avgInMs: a.transfers ? a.inMs / a.transfers : 0,
            avgPolls: a.transfers ? a.polls / a.transfers : 0,
          });
          a.frames = 0;
          a.transfers = 0;
          a.bytes = 0;
          a.peakActualBytes = 0;
          a.outMs = 0; a.inMs = 0; a.polls = 0;
          a.t0 = now;
        }
      }
      if (!quiet) addLog(`Read display-list ${raw.length} bytes`);
      const decodedFrames = decodeDisplayList(raw.buffer);

      if (decodedFrames.length === 0) {
        if (!quiet) addLog('Display list empty — controller may be rebooting', '');
        return 'no-controller';
      }

      setFrames(decodedFrames);
      setFrameIndex(0);
      if (!quiet) addLog(`Decoded ${decodedFrames.length} frame(s)`, 'success');
      return 'ok';
    } catch (e) {
      // "Expected BEGIN_FRAME" means we got an all-zero response — controller
      // is unplugged or rebooting into video mode. Treat the same as a
      // timeout: caller will back off and retry.
      if (String(e).includes('BEGIN_FRAME') || String(e).includes('timeout')) {
        if (!quiet) addLog('No controller response', '');
        return 'no-controller';
      }
      if (!quiet) addLog('Read failed: ' + e, 'error');
      return 'error';
    }
  }

  // Auto-poll: continuously read display-list whenever the adapter is open.
  // Paces to ~60 fps when the controller is responding; falls back to 1 Hz
  // when it isn't (so a freshly-plugged controller is picked up automatically).
  useEffect(() => {
    if (!usbDevice || !assetsLoaded) return;
    let cancelled = false;
    const minFrameMs = 1000 / 60;
    async function loop() {
      while (!cancelled) {
        const t0 = performance.now();
        const status = await withUsbLock(() => readDisplayList({ quiet: true }));
        if (cancelled) break;
        setDisplayActive(status === 'ok');
        if (status === 'ok') {
          const elapsed = performance.now() - t0;
          const wait = Math.max(0, minFrameMs - elapsed);
          await new Promise(r => setTimeout(r, wait));
        } else {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    loop();
    return () => { cancelled = true; setDisplayActive(false); };
  }, [usbDevice, assetsLoaded, controller]);

  // TV-static animation when display list is not active.
  useEffect(() => {
    if (displayActive) {
      if (staticRafRef.current) { cancelAnimationFrame(staticRafRef.current); staticRafRef.current = null; }
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    function drawStatic() {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const lw = (w / PIXEL_SCALE) | 0;
      const lh = (h / PIXEL_SCALE) | 0;
      const imageData = ctx.createImageData(lw, lh);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = (Math.random() * 180) | 0;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
      const tmp = new OffscreenCanvas(lw, lh);
      tmp.getContext('2d').putImageData(imageData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, w, h);
      staticRafRef.current = requestAnimationFrame(drawStatic);
    }
    drawStatic();
    return () => { if (staticRafRef.current) { cancelAnimationFrame(staticRafRef.current); staticRafRef.current = null; } };
  }, [displayActive]);

  async function fetchMetadata() {
    // Fetches metadata from controller and returns parsed obj. Throws on failure.
    const port = (controller - 1) & 0x3;
    const first = await joybusTransfer(port, new Uint8Array([0xA0, 0x00]), { maxRespLen: METADATA_TRANSFER_SIZE });
    const totalChunks = first[0];
    if (totalChunks < 1 || totalChunks > METADATA_MAX_CHUNKS) {
      throw new Error(`Unexpected metadata chunk count: ${totalChunks}`);
    }
    const chunks = [first.slice(2)];
    for (let i = 1; i < totalChunks; i++) {
      const resp = await joybusTransfer(port, new Uint8Array([0xA0, i]), { maxRespLen: METADATA_TRANSFER_SIZE });
      chunks.push(resp.slice(2));
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const raw = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { raw.set(c, off); off += c.length; }
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0) end--;
    const trimmed = raw.slice(0, end);
    try {
      return ubjsonDecode(trimmed);
    } catch (_) {
      return { name: new TextDecoder().decode(trimmed) };
    }
  }

  function applyMetadataToForm(obj) {
    setMetaName(obj.name || '');
    setMetaNametag(obj.nametag || '');
    setMetaSlippi(obj.slippi || '');
    setMetaSmashGG(obj.smashgg || '');
    setMetaParryGG(obj.parrygg || '');
    setMetaFirmware(obj.firmware || '');
  }

  // Poll metadata every 1.3 s whenever the adapter is open.
  useEffect(() => {
    if (!usbDevice) {
      setMetaAvailable(false);
      return;
    }
    let cancelled = false;
    async function pollMeta() {
      while (!cancelled) {
        if (!metaLockRef.current) {
          metaLockRef.current = true;
          try {
            const obj = await withUsbLock(() => fetchMetadata());
            if (!cancelled) {
              const prev = lastPolledMetaRef.current;
              if (JSON.stringify(obj) !== JSON.stringify(prev)) {
                applyMetadataToForm(obj);
              }
              lastPolledMetaRef.current = obj;
              setMetaAvailable(true);
            }
          } catch (_) {
            if (!cancelled) setMetaAvailable(false);
          } finally {
            metaLockRef.current = false;
          }
        }
        await new Promise(r => setTimeout(r, 1300));
      }
    }
    pollMeta();
    return () => { cancelled = true; };
  }, [usbDevice, controller]);

  async function setControllerMetadata() {
    if (!usbDevice) { addLog('Open adapter first', 'error'); return; }
    if (metaLockRef.current) { addLog('Metadata transfer in progress', 'error'); return; }
    metaLockRef.current = true;
    const port = (controller - 1) & 0x3;
    try {
      await withUsbLock(async () => {
        // Fetch current state and verify it matches our last poll (optimistic concurrency).
        const current = await fetchMetadata();
        const last = lastPolledMetaRef.current;
        if (last !== null && JSON.stringify(current) !== JSON.stringify(last)) {
          throw new Error('Metadata changed on controller since last poll — aborting save');
        }
        const raw = ubjsonEncode({ nametag: metaNametag, name: metaName, slippi: metaSlippi, smashgg: metaSmashGG, parrygg: metaParryGG, firmware: metaFirmware });
        if (raw.length > METADATA_MAX_BYTES) {
          throw new Error(`Metadata too large (${raw.length}/${METADATA_MAX_BYTES} B)`);
        }
        const totalChunks = Math.max(1, Math.ceil(raw.length / METADATA_CHUNK_DATA_SIZE));
        for (let i = 0; i < totalChunks; i++) {
          const chunk = raw.slice(i * METADATA_CHUNK_DATA_SIZE, (i + 1) * METADATA_CHUNK_DATA_SIZE);
          // Layout mirrors the read response: [cmd][total_chunks][index][data].
          // The device only advertises a non-zero chunk count once the final
          // chunk arrives, so it persists exactly once, after the full burst.
          const cmd = new Uint8Array(3 + METADATA_CHUNK_DATA_SIZE);
          cmd[0] = 0xB0; cmd[1] = totalChunks; cmd[2] = i;
          cmd.set(chunk, 3);
          await joybusTransfer(port, cmd, { maxRespLen: 1, timeoutMs: 500 });
        }
        // Read back from device to confirm the write landed.
        const intended = { nametag: metaNametag, name: metaName, slippi: metaSlippi, smashgg: metaSmashGG, parrygg: metaParryGG, firmware: metaFirmware };
        const readback = await fetchMetadata();
        if (JSON.stringify(readback) !== JSON.stringify(intended)) {
          throw new Error(`Metadata readback mismatch — device has: ${JSON.stringify(readback)}`);
        }
        lastPolledMetaRef.current = readback;
        addLog(`Metadata saved and verified (${raw.length} B, ${totalChunks} chunk(s))`, 'success');
      });
    } catch (e) {
      addLog(String(e).replace(/^Error: /, ''), 'error');
    }
    metaLockRef.current = false;
  }

  const PIXEL_SCALE = 2;

  useEffect(() => {
    if (frames.length > 0 && assetsLoaded) {
      renderFrame(frames, frameIndex, PIXEL_SCALE);
    }
  }, [frameIndex, frames, assetsLoaded]);

  const renderFrame = (framesData, idx, scale) => {
    if (!framesData.length || !canvasRef.current || !assetsLoaded) return;

    const frame = framesData[Math.min(idx, framesData.length - 1)];
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    canvas.width = frame.width * scale;
    canvas.height = frame.height * scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    for (const op of frame.ops) {
      try {
        renderOp(ctx, op, scale);
      } catch (err) {
        console.error('Error rendering op:', op, err);
      }
    }

    // Update meta info (frame-static fields only; live perf goes in JSX
    // below so it updates every cycle even when the frame doesn't change).
    const breakdown = Object.entries(frame.opStats || {})
      .map(([op, s]) => ({ op: Number(op), ...s }))
      .sort((a, b) => b.bytes - a.bytes)
      .map(e => `  ${OPCODE_NAMES[e.op] || ('0x' + e.op.toString(16))}: ${e.count}\u00d7 = ${e.bytes} B`)
      .join('\n');
    setMeta(`frames: ${framesData.length}
frameId: ${frame.frameId}
frameIndex: ${Math.min(idx, framesData.length - 1)}
size: ${frame.width}x${frame.height}
redrawType: ${frame.redrawType}
ops: ${frame.ops.length}
droppedOps: ${frame.droppedOps}
op bytes:
${breakdown}`);
  };

  const renderOp = (ctx, op, scale) => {
    const colorFromIndex = (index) => {
      const safe = index & 0x0f;
      return DEFAULT_PALETTE[safe] || '#ff00ff';
    };

    if (op.op === OPCODES.CLEAR) {
      ctx.fillStyle = colorFromIndex(op.color);
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      return;
    }

    if (op.op === OPCODES.FILL_ROWS) {
      ctx.fillStyle = colorFromIndex(op.color);
      ctx.fillRect(0, op.y * scale, ctx.canvas.width, op.rows * scale);
      return;
    }

    if (op.op === OPCODES.LINE || op.op === OPCODES.HLINE || op.op === OPCODES.VLINE) {
      ctx.strokeStyle = colorFromIndex(op.color);
      ctx.lineWidth = Math.max(1, scale);
      ctx.beginPath();
      ctx.moveTo(op.x0 * scale + 0.5, op.y0 * scale + 0.5);
      ctx.lineTo(op.x1 * scale + 0.5, op.y1 * scale + 0.5);
      ctx.stroke();
      return;
    }

    if (op.op === OPCODES.STRING) {
      drawBitmapText(ctx, op.x, op.y, op.text, colorFromIndex(op.color), op.scale, scale);
      return;
    }

    if (op.op === OPCODES.IMAGE_REF) {
      // Map firmware image ID -> bundled asset name
      const assetName = IMAGE_ID_TO_NAME[op.imageId];
      const imgResult = assetName ? decodeRLEImage(assetName, DEFAULT_PALETTE) : null;
      if (imgResult) {
        ctx.drawImage(
          imgResult.canvas,
          op.x * scale,
          op.y * scale,
          op.width * scale,
          op.height * scale
        );
      } else {
        // Draw placeholder
        const px = op.x * scale;
        const py = op.y * scale;
        const pw = op.width * scale;
        const ph = op.height * scale;

        ctx.strokeStyle = '#00c2ff';
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, pw, ph);

        ctx.fillStyle = 'rgba(0, 194, 255, 0.15)';
        ctx.fillRect(px, py, pw, ph);

        ctx.fillStyle = '#00c2ff';
        ctx.font = `${10 * scale}px monospace`;
        ctx.textBaseline = 'top';
        ctx.fillText(`img:${op.imageId.toString(16)}`, px + 2, py + 2);
      }
    }
  };

  return (
    <div style={styles.container}>
      {toast && (
        <div
          style={{ ...styles.toast, background: toast.level === 'success' ? '#27ae60' : '#c0392b' }}
          onClick={() => setToast(null)}
        >
          {toast.msg}
        </div>
      )}
      <div style={styles.header}>
        <h1 style={{ margin: 0 }}>Gamecube Controller WebUSB Interface</h1>
      </div>

      <div style={styles.panel}>
        <div style={styles.row}>
          <button style={styles.button} onClick={openWebUSB}>Open Adapter (WebUSB)</button>
          <button style={{ ...styles.button, ...styles.buttonSecondary }} onClick={closeWebUSB}>Close</button>
          <label style={{ ...styles.small, marginLeft: 'auto' }}>Controller:</label>
          <select
            value={controller}
            onChange={(e) => setController(Number(e.target.value))}
            style={styles.input}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
          <div style={{ marginLeft: 'auto', fontSize: 13, color: '#cfcfe0' }}>VID:PID 0x057e:0x0337</div>
        </div>
      </div>

      <div style={{ ...styles.panel, display: 'inline-block' }}>
        <div style={{ ...styles.row, marginBottom: 8, justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 14, color: '#cfcfe0' }}>Controller Metadata</strong>
          <button
            style={{ ...styles.button, ...(!metaAvailable && { background: '#555', cursor: 'not-allowed' }) }}
            onClick={setControllerMetadata}
            disabled={!metaAvailable}
          >Save</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 300px', gap: '4px 8px', alignItems: 'center', cursor: !metaAvailable ? 'not-allowed' : undefined }}>
            <label style={styles.small}>Nametag</label>
            <input style={styles.input} value={metaNametag} onChange={e => setMetaNametag(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase())} placeholder="ABCD" maxLength={4} disabled={!metaAvailable} />
            <label style={styles.small}>Display Name</label>
            <input style={styles.input} value={metaName} onChange={e => setMetaName(e.target.value)} placeholder="Player tag" disabled={!metaAvailable} />
            <label style={styles.small}>Slippi Code</label>
            <input style={styles.input} value={metaSlippi} onChange={e => setMetaSlippi(e.target.value)} placeholder="ABC#123" disabled={!metaAvailable} />
            <label style={styles.small}>SmashGG</label>
            <input style={styles.input} value={metaSmashGG} onChange={e => setMetaSmashGG(e.target.value)} placeholder="start.gg slug" disabled={!metaAvailable} />
            <label style={styles.small}>ParryGG</label>
            <input style={styles.input} value={metaParryGG} onChange={e => setMetaParryGG(e.target.value)} placeholder="parry.gg ID" disabled={!metaAvailable} />
            <label style={styles.small}>Firmware</label>
            <input style={styles.input} value={metaFirmware} onChange={e => setMetaFirmware(e.target.value)} placeholder="e.g. 0.28" disabled={!metaAvailable} />
        </div>
      </div>

      {!assetsLoaded && <div style={styles.status}>Loading assets...</div>}

      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 4, color: '#cfcfe0', textTransform: 'uppercase', marginTop: 36, marginBottom: 12, textAlign: 'center' }}>PhobVision</div>

      <canvas
        ref={canvasRef}
        width={512 * 2}
        height={384 * 2}
        style={{ ...styles.canvas, display: 'block', margin: '0 auto' }}
      />

      <pre style={styles.meta}>{meta}</pre>

      <pre style={styles.meta}>{`fps: ${fps.fps.toFixed(1)}
transfers/s: ${fps.transfersPerSec.toFixed(1)} (${fps.chunksPerFrame} chunks/frame, ${fps.bytesPerFrame} B/frame)
actual DL: ${fps.actualBytesPerFrame ?? 0} B (peak ${fps.peakActualBytes ?? 0} B over last interval)
per-xfer: out ${(fps.avgOutMs ?? 0).toFixed(1)} ms, in ${(fps.avgInMs ?? 0).toFixed(1)} ms (${(fps.avgPolls ?? 0).toFixed(1)} polls)`}</pre>

      <div style={{ ...styles.row, marginTop: 4 }}>
        <button
          style={{ ...styles.button, ...styles.buttonSecondary }}
          onClick={() => {
            const text = `${meta}
fps: ${fps.fps.toFixed(1)}
transfers/s: ${fps.transfersPerSec.toFixed(1)} (${fps.chunksPerFrame} chunks/frame, ${fps.bytesPerFrame} B/frame)
actual DL: ${fps.actualBytesPerFrame ?? 0} B (peak ${fps.peakActualBytes ?? 0} B over last interval)
per-xfer: out ${(fps.avgOutMs ?? 0).toFixed(1)} ms, in ${(fps.avgInMs ?? 0).toFixed(1)} ms (${(fps.avgPolls ?? 0).toFixed(1)} polls)`;
            navigator.clipboard.writeText(text)
              .then(() => addLog('Copied stats to clipboard', 'success'))
              .catch(e => addLog('Copy failed: ' + e, 'error'));
          }}
        >
          Copy Stats
        </button>
      </div>

      <div style={styles.log}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Log</div>
        {log.map((l, i) => (
          <div key={i} style={l.level === 'error' ? { color: '#e08e8e' } : l.level === 'success' ? { color: '#8ee08e' } : {}}>
            <div style={{ fontSize: 12 }}>
              {new Date(l.ts).toLocaleTimeString()} {l.msg}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  toast: {
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#c0392b',
    color: '#fff',
    padding: '10px 20px',
    borderRadius: 6,
    fontFamily: 'monospace',
    fontSize: 14,
    zIndex: 9999,
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    cursor: 'pointer',
    maxWidth: '80vw',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  container: {
    maxWidth: 1200,
    margin: '28px auto',
    padding: 20,
    borderRadius: 8,
    background: '#000000',
    color: '#ffffff',
    fontFamily: 'Inter, Roboto, system-ui, -apple-system, sans-serif',
    minHeight: '100vh',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  panel: {
    background: '#0a0a0a',
    padding: 12,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.03)',
    marginTop: 12,
  },
  row: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  button: {
    background: '#485CC7',
    color: 'white',
    border: 'none',
    padding: '8px 12px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  buttonSecondary: {
    background: 'transparent',
    border: '1px solid rgba(255, 255, 255, 0.08)',
  },
  input: {
    background: '#101010',
    border: '1px solid rgba(255, 255, 255, 0.03)',
    color: '#ffffff',
    padding: 8,
    borderRadius: 6,
    cursor: 'inherit',
  },
  small: {
    fontSize: 13,
    color: '#cfcfe0',
  },
  canvas: {
    background: '#000',
    imageRendering: 'pixelated',
    width: 1024,
    height: 768,
    marginTop: 12,
  },
  meta: {
    marginTop: 8,
    fontFamily: 'monospace',
    fontSize: 13,
    whiteSpace: 'pre',
    color: '#cfcfe0',
    background: '#070707',
    padding: 8,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.03)',
  },
  status: {
    padding: 8,
    background: '#0a0a0a',
    borderRadius: 4,
    marginTop: 12,
    border: '1px solid rgba(255, 255, 255, 0.03)',
  },
  log: {
    marginTop: 12,
    maxHeight: 240,
    overflow: 'auto',
    background: '#070707',
    padding: 8,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.03)',
  },
};
