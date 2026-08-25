// SSTV mini-app — image encode/decode (Martin, Scottie, Robot), the slot-based
// image editor with text layers, screen capture, and the RX gallery.
//
// Constraints worth knowing before changing anything here:
//
// - Encoding and decoding both run on the main thread against an AudioContext.
//   A long transmission will block; that is a known limit, not a subtlety.
//
// - Captured and edited images are held as data URLs in module state, and the
//   gallery persists to localStorage. Large images are the reason the gallery is
//   capped rather than unbounded.
//
// - This app queries its elements with a local `$` helper by id rather than
//   scoping to panelEl, because a few controls sit outside its own panel.
let appCtx = null;

    /* ---------------------------------------------------------------
       SSTV Engine — Multi-Mode with Auto-Detection
       Decoder: zero-crossing frequency estimator, timing-segment state machine,
                and buffer-based VIS auto-detector.
       Encoder: phase-continuous multi-mode audio generator.
       --------------------------------------------------------------- */

    /* ---- Utility: template code expansion ---- */
    function expandTemplates(text) {
      // Pull the most recent QSO from the logbook connector and the
      // operator's own callsign from settings — replaces a prior DOM-scrape
      // of #log-table/#my-callsign/#station-callsign, none of which exist
      // in index.html (dead ids left behind by a logger markup rename), so
      // every macro used to silently fall back to '—'/'W1AW'.
      const qsos = appCtx ? appCtx.logbook.qsos() : [];
      const qso = qsos.length ? qsos[qsos.length - 1] : null;
      const field = (name, fallback) => (qso && qso[name] && String(qso[name]).trim()) || fallback;
      const now = new Date();
      const dateStr = now.toISOString().slice(0,10);
      const myCall = (appCtx && appCtx.settings.get().stationCall?.trim()) || 'W1AW';
      return text
        .replace(/\{CALL\}/g,   field('callsign', '—'))
        .replace(/\{MYCALL\}/g, myCall)
        .replace(/\{NAME\}/g,   field('operatorName', '—'))
        .replace(/\{GRID\}/g,   field('gridSquare', '—'))
        .replace(/\{RST\}/g,    field('rstSent', '59'))
        .replace(/\{FREQ\}/g,   field('frequency', '—'))
        .replace(/\{MODE\}/g,   field('mode', '—'))
        .replace(/\{DATE\}/g,   dateStr);
    }

    // 15+ SSTV Modes Metadata
    const MODES = {
      robot24: {
        id: 'robot24',
        name: 'Robot 24',
        vis: 10,
        w: 160,
        h: 120,
        family: 'robot24',
        syncMs: 12,
        porchMs: 6,
        yMs: 88,
        sepMs: 4,
        cMs: 44
      },
      robot36: {
        id: 'robot36',
        name: 'Robot 36',
        vis: 8,
        w: 320,
        h: 240,
        family: 'robot',
        syncMs: 9,
        porchMs: 3,
        yMs: 88,
        sepMs: 4.5,
        cMs: 44
      },
      robot72: {
        id: 'robot72',
        name: 'Robot 72',
        vis: 12,
        w: 320,
        h: 240,
        family: 'robot',
        syncMs: 9,
        porchMs: 3,
        yMs: 176,
        sepMs: 4.5,
        cMs: 88
      },
      martin1: {
        id: 'martin1',
        name: 'Martin M1',
        vis: 44,
        w: 320,
        h: 256,
        family: 'martin',
        syncMs: 4.862,
        porchMs: 0.572,
        yMs: 146.432,
        sepMs: 0.572
      },
      martin2: {
        id: 'martin2',
        name: 'Martin M2',
        vis: 40,
        w: 320,
        h: 256,
        family: 'martin',
        syncMs: 2.431,
        porchMs: 0.286,
        yMs: 73.216,
        sepMs: 0.286
      },
      scottie1: {
        id: 'scottie1',
        name: 'Scottie S1',
        vis: 60,
        w: 320,
        h: 256,
        family: 'scottie',
        syncMs: 9,
        porchMs: 1.5,
        yMs: 138.24,
        sepMs: 1.5
      },
      scottie2: {
        id: 'scottie2',
        name: 'Scottie S2',
        vis: 56,
        w: 320,
        h: 256,
        family: 'scottie',
        syncMs: 9,
        porchMs: 1.5,
        yMs: 88.064,
        sepMs: 1.5
      },
      scottiedx: {
        id: 'scottiedx',
        name: 'Scottie DX',
        vis: 76,
        w: 320,
        h: 256,
        family: 'scottie',
        syncMs: 9,
        porchMs: 1.5,
        yMs: 345.6,
        sepMs: 1.5
      },
      pd50: {
        id: 'pd50',
        name: 'PD-50',
        vis: 93,
        w: 320,
        h: 256,
        family: 'pd',
        syncMs: 20,
        porchMs: 2.08,
        yMs: 91.52
      },
      pd90: {
        id: 'pd90',
        name: 'PD-90',
        vis: 99,
        w: 320,
        h: 256,
        family: 'pd',
        syncMs: 20,
        porchMs: 2.08,
        yMs: 170.24
      },
      pd120: {
        id: 'pd120',
        name: 'PD-120',
        vis: 95,
        w: 640,
        h: 496,
        family: 'pd',
        syncMs: 20,
        porchMs: 2.08,
        yMs: 121.6
      },
      pd160: {
        id: 'pd160',
        name: 'PD-160',
        vis: 98,
        w: 512,
        h: 400,
        family: 'pd',
        syncMs: 20,
        porchMs: 2.08,
        yMs: 195.584
      },
      pd180: {
        id: 'pd180',
        name: 'PD-180',
        vis: 96,
        w: 640,
        h: 496,
        family: 'pd',
        syncMs: 20,
        porchMs: 2.08,
        yMs: 183.04
      },
      pd240: {
        id: 'pd240',
        name: 'PD-240',
        vis: 97,
        w: 640,
        h: 496,
        family: 'pd',
        syncMs: 20,
        porchMs: 2.08,
        yMs: 244.48
      },
      pasokonp3: {
        id: 'pasokonp3',
        name: 'Pasokon P3',
        vis: 113,
        w: 640,
        h: 496,
        family: 'pasokon',
        syncMs: 5.208,
        porchMs: 1.042,
        yMs: 133.333
      },
      pasokonp5: {
        id: 'pasokonp5',
        name: 'Pasokon P5',
        vis: 114,
        w: 640,
        h: 496,
        family: 'pasokon',
        syncMs: 7.813,
        porchMs: 1.563,
        yMs: 200.0
      },
      pasokonp7: {
        id: 'pasokonp7',
        name: 'Pasokon P7',
        vis: 115,
        w: 640,
        h: 496,
        family: 'pasokon',
        syncMs: 10.417,
        porchMs: 2.083,
        yMs: 266.666
      }
    };

    /* ---- Shared state ---- */
    const state = {
      audioCtx: null,
      rxStream: null,
      rxProcessor: null,
      rxSourceNode: null,
      rxActive: false,
      txActive: false,
      txSource: null,
      txSinkEl: null,
      mode: 'auto',
      layers: [],          // { text, x, y, size, color, shadow, font }
      slots: {},           // slot name → data-URL
      activeEditorSlot: 'cq',
      gallery: [],
      rxCanvas: null,
      txCanvas: null,
      editorCanvas: null,
      decoder: null,
    };

    const $ = id => document.getElementById(id);

    function initRefs() {
      state.rxCanvas     = $('sstv-rx-canvas');
      state.txCanvas     = $('sstv-tx-canvas');
      state.editorCanvas = $('sstv-editor-canvas');
    }

    function getAudioCtx() {
      if (!state.audioCtx || state.audioCtx.state === 'closed') {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
      return state.audioCtx;
    }

    function configureCanvasesForMode(modeId) {
      if (modeId === 'auto') return;
      const m = MODES[modeId];
      if (!m) return;

      state.rxCanvas.width = m.w;
      state.rxCanvas.height = m.h;
      state.txCanvas.width = m.w;
      state.txCanvas.height = m.h;
      state.editorCanvas.width = m.w;
      state.editorCanvas.height = m.h;

      $('sstv-rx-lines').textContent = `0 / ${m.h}`;
      refreshEditorCanvas();
    }

    /* ===================================================
       DECODER — modular, segment-based line decoding
       ================================================================== */
    class SSTVDecoder {
      constructor(sr, initialModeId, { onLine, onComplete, onStatus, onModeDetected }) {
        this.SR = sr;
        this.onLine = onLine;
        this.onComplete = onComplete;
        this.onStatus = onStatus;
        this.onModeDetected = onModeDetected;

        // Bandpass filter variables (HP @ 500 Hz, LP @ 3000 Hz)
        this._hpR = Math.exp(-2 * Math.PI * 500 / sr);
        this._lpA = 1 - Math.exp(-2 * Math.PI * 3000 / sr);
        this._hpY = 0; this._hpX = 0; this._lpY = 0;
        this._pf = 0; this._pc = -1; this._hz = 1700; this._si2 = 0;

        // VIS detector state variables
        this._visBuffering = false;
        this._visBuffer = [];
        this._visBufferTarget = 0;
        this._visState = 'LEADER1';
        this._visCount = 0;

        this.setMode(initialModeId);
      }

      setMode(modeId) {
        this.modeId = modeId;
        this.mode = MODES[modeId] || null; // null if auto-detect
        this._reset();
      }

      _reset() {
        this._lineY = 0;
        this._syncCount = 0;
        this._skipCount = 0;

        if (this.mode) {
          this._buildSegments();
          this._prepareLineBuffers();
          this._state = 'SYNC_SEARCH';
          this._currentSegmentIdx = 0;
          this._segmentSampleCount = 0;
        } else {
          this._state = 'VIS_ONLY';
        }
      }

      _buildSegments() {
        const sr = this.SR;
        const n = ms => Math.round(ms * sr / 1000);
        const m = this.mode;
        
        this.segments = [];
        
        if (m.family === 'robot') {
          this.segments = [
            { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
            { type: 'porch', len: n(m.porchMs), hz: 1500 },
            { type: 'y',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
            { type: 'c',     len: n(m.cMs) }
          ];
        } else if (m.family === 'robot24') {
          this.segments = [
            { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
            { type: 'porch', len: n(m.porchMs), hz: 1500 },
            { type: 'y',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
            { type: 'cb',    len: n(m.cMs) },
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
            { type: 'cr',    len: n(m.cMs) }
          ];
        } else if (m.family === 'martin') {
          this.segments = [
            { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
            { type: 'porch', len: n(m.porchMs), hz: 1500 },
            { type: 'g',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
            { type: 'b',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
            { type: 'r',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 }
          ];
        } else if (m.family === 'scottie') {
          this.segments = [
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
            { type: 'g',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
            { type: 'b',     len: n(m.yMs) },
            { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
            { type: 'porch', len: n(m.porchMs), hz: 1500 },
            { type: 'r',     len: n(m.yMs) }
          ];
        } else if (m.family === 'pd') {
          this.segments = [
            { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
            { type: 'porch', len: n(m.porchMs), hz: 1500 },
            { type: 'y0',    len: n(m.yMs) },
            { type: 'cr',    len: n(m.yMs) },
            { type: 'cb',    len: n(m.yMs) },
            { type: 'y1',    len: n(m.yMs) }
          ];
        } else if (m.family === 'pasokon') {
          this.segments = [
            { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
            { type: 'porch', len: n(m.porchMs), hz: 1500 },
            { type: 'r',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.porchMs), hz: 1500 },
            { type: 'g',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.porchMs), hz: 1500 },
            { type: 'b',     len: n(m.yMs) },
            { type: 'sep',   len: n(m.porchMs), hz: 1500 }
          ];
        }
      }

      _prepareLineBuffers() {
        const w = this.mode.w;
        this._acc = {};
        this._cnt = {};

        this.segments.forEach(seg => {
          if (['y', 'c', 'r', 'g', 'b', 'y0', 'y1', 'cr', 'cb'].includes(seg.type)) {
            const width = (seg.type === 'c' || seg.type === 'cb' || seg.type === 'cr') ? (w / 2) : w;
            this._acc[seg.type] = new Float64Array(width);
            this._cnt[seg.type] = new Uint32Array(width);
          }
        });

        this._yStore = [];
        this._cbStore = [];
        this._crStore = [];
        this._rStore = [];
        this._gStore = [];
        this._bStore = [];
      }

      _clearLineAccumulators() {
        for (const type in this._acc) {
          this._acc[type].fill(0);
          this._cnt[type].fill(0);
        }
      }

      _demod(s) {
        const hp = s - this._hpX + this._hpR * this._hpY;
        this._hpX = s; this._hpY = hp;
        this._lpY += this._lpA * (hp - this._lpY);
        const f = this._lpY;
        if (this._pf <= 0 && f > 0) {
          const t = this._si2 - f / (f - this._pf);
          if (this._pc >= 0) {
            const freq = this.SR / (t - this._pc);
            if (freq >= 900 && freq <= 3200) this._hz = freq;
          }
          this._pc = t;
        }
        this._pf = f; this._si2++;
        return this._hz;
      }

      process(buf) {
        for (let i = 0; i < buf.length; i++) {
          const hz = this._demod(buf[i]);

          if (this._visBuffering) {
            this._visBuffer.push(hz);
            if (this._visBuffer.length >= this._visBufferTarget) {
              this._visBuffering = false;
              this._analyzeVIS();
            }
          } else {
            this._visProcess(hz);
          }

          if (this.mode) {
            this._decodeSample(hz);
          }
        }
      }

      _visProcess(hz) {
        const msToSamples = ms => Math.round(ms * this.SR / 1000);
        
        switch (this._visState) {
          case 'LEADER1':
            if (hz >= 1780 && hz <= 2020) {
              this._visCount++;
            } else {
              if (this._visCount >= msToSamples(120) && hz >= 1080 && hz <= 1320) {
                this._visState = 'BREAK';
                this._visCount = 1;
              } else {
                this._visCount = 0;
              }
            }
            break;

          case 'BREAK':
            if (hz >= 1080 && hz <= 1320) {
              this._visCount++;
            } else {
              if (this._visCount >= msToSamples(5) && this._visCount <= msToSamples(25)) {
                this._visState = 'LEADER2';
              } else {
                this._visState = 'LEADER1';
              }
              this._visCount = 0;
            }
            break;

          case 'LEADER2':
            if (hz >= 1780 && hz <= 2020) {
              this._visCount++;
            } else {
              if (this._visCount >= msToSamples(120) && hz >= 1080 && hz <= 1320) {
                this._visState = 'WAIT_START';
                this._visCount = 1;
              } else {
                this._visCount = 0;
              }
            }
            break;

          case 'WAIT_START':
            if (hz >= 1080 && hz <= 1320) {
              this._visBuffering = true;
              this._visBuffer = [hz];
              this._visBufferTarget = msToSamples(300); // 10 bins of 30 ms
              this._visState = 'LEADER1';
              this._visCount = 0;
            }
            break;
        }
      }

      _analyzeVIS() {
        const binLength = Math.round(this._visBuffer.length / 10);
        const getBinAverage = binIdx => {
          let sum = 0;
          const start = binIdx * binLength;
          const end = Math.min(start + binLength, this._visBuffer.length);
          for (let i = start; i < end; i++) sum += this._visBuffer[i];
          return sum / (end - start);
        };

        const startHz = getBinAverage(0);
        const stopHz = getBinAverage(9);

        if (startHz < 1050 || startHz > 1350 || stopHz < 1050 || stopHz > 1350) {
          console.log(`VIS rejected: startHz=${startHz.toFixed(1)}, stopHz=${stopHz.toFixed(1)}`);
          return;
        }

        // Start & stop bits are both nominally 1200 Hz; their average is the true
        // "1200" reference under the current tuning. Slice data bits against it so
        // a mistuned signal (off-frequency) still decodes 1100=1 / 1300=0 correctly.
        const ref = (startHz + stopHz) / 2;
        const bits = [];
        for (let b = 0; b < 8; b++) {
          const avg = getBinAverage(b + 1);
          bits.push(avg < ref ? 1 : 0);
        }

        let parity = 0;
        for (let b = 0; b < 8; b++) parity ^= bits[b];

        const visCode = bits[0] | (bits[1] << 1) | (bits[2] << 2) | (bits[3] << 3) | (bits[4] << 4) | (bits[5] << 5) | (bits[6] << 6);
        console.log(`VIS detected: code=${visCode} (0x${visCode.toString(16)}), parityOk=${parity === 0}`);

        if (parity === 0 || Object.values(MODES).some(m => m.vis === visCode)) {
          if (this.onModeDetected) {
            this.onModeDetected(visCode);
          }
        }
      }

      _decodeSample(hz) {
        switch (this._state) {
          case 'SYNC_SEARCH': {
            const syncSegIdx = this.segments.findIndex(s => s.type === 'sync');
            if (syncSegIdx === -1) {
              this._state = 'DECODE_LINE';
              this._currentSegmentIdx = 0;
              this._segmentSampleCount = 0;
              this._clearLineAccumulators();
              break;
            }
            const syncSeg = this.segments[syncSegIdx];
            const minSync = Math.round(syncSeg.len * 0.6);

            if (hz >= 1080 && hz <= 1320) {
              this._syncCount++;
              if (this._syncCount >= minSync) {
                this._syncCount = 0;
                this._skipCount = 0;
                this._currentSegmentIdx = syncSegIdx + 1;
                this._segmentSampleCount = 0;
                this._state = 'DECODE_LINE';
                this._clearLineAccumulators();

                if (this.onStatus) this.onStatus(`sync L${this._lineY}`);
              }
            } else {
              this._syncCount = 0;
            }
            break;
          }

          case 'DECODE_LINE': {
            const seg = this.segments[this._currentSegmentIdx];
            this._segmentSampleCount++;

            if (seg.type === 'sync' && hz >= 1080 && hz <= 1320) {
              this._syncCount++;
              if (this._syncCount >= Math.round(seg.len * 0.6)) {
                this._syncCount = 0;
                this._segmentSampleCount = seg.len;
              }
            } else {
              this._syncCount = 0;
            }

            const val = Math.max(0, Math.min(255, (hz - 1500) / 800 * 255));

            if (this._acc[seg.type]) {
              const acc = this._acc[seg.type];
              const cnt = this._cnt[seg.type];
              const width = acc.length;
              const px = Math.floor((this._segmentSampleCount - 1) * width / seg.len);
              if (px >= 0 && px < width) {
                acc[px] += val;
                cnt[px]++;
              }
            }

            if (this._segmentSampleCount >= seg.len) {
              this._segmentSampleCount = 0;
              this._currentSegmentIdx++;

              if (this._currentSegmentIdx >= this.segments.length) {
                this._emitLine();
                this._currentSegmentIdx = 0;
                this._clearLineAccumulators();
                this._state = 'SYNC_SEARCH';
                this._syncCount = 0;
              }
            }
            break;
          }
        }
      }

      _emitLine() {
        const y = this._lineY;
        const w = this.mode.w;
        const h = this.mode.h;
        const family = this.mode.family;

        if (family === 'robot') {
          const isEven = (y % 2 === 0);
          
          this._yStore[y] = new Float64Array(this._acc['y']);
          for (let x = 0; x < w; x++) {
            if (this._cnt['y'][x] > 0) this._yStore[y][x] /= this._cnt['y'][x];
          }

          const cWidth = w / 2;
          const cData = new Float64Array(this._acc['c']);
          for (let x = 0; x < cWidth; x++) {
            if (this._cnt['c'][x] > 0) cData[x] /= this._cnt['c'][x];
          }

          if (isEven) this._cbStore[y] = cData;
          else        this._crStore[y] = cData;

          if (!isEven && y >= 1) {
            this._renderRobotLine(y - 1);
            this._renderRobotLine(y);
          }

          this._lineY++;
          if (this.onStatus) this.onStatus(`line ${y}`);
          if (this._lineY >= h) {
            this._lineY = 0;
            if (this.onComplete) this.onComplete();
          }
        }
        else if (family === 'robot24') {
          this._yStore[y] = new Float64Array(this._acc['y']);
          this._cbStore[y] = new Float64Array(this._acc['cb']);
          this._crStore[y] = new Float64Array(this._acc['cr']);

          for (let x = 0; x < w; x++) {
            if (this._cnt['y'][x] > 0) this._yStore[y][x] /= this._cnt['y'][x];
          }
          const cWidth = w / 2;
          for (let x = 0; x < cWidth; x++) {
            if (this._cnt['cb'][x] > 0) this._cbStore[y][x] /= this._cnt['cb'][x];
            if (this._cnt['cr'][x] > 0) this._crStore[y][x] /= this._cnt['cr'][x];
          }

          this._renderRobot24Line(y);

          this._lineY++;
          if (this.onStatus) this.onStatus(`line ${y}`);
          if (this._lineY >= h) {
            this._lineY = 0;
            if (this.onComplete) this.onComplete();
          }
        }
        else if (family === 'martin' || family === 'scottie' || family === 'pasokon') {
          this._rStore[y] = new Float64Array(this._acc['r']);
          this._gStore[y] = new Float64Array(this._acc['g']);
          this._bStore[y] = new Float64Array(this._acc['b']);

          for (let x = 0; x < w; x++) {
            if (this._cnt['r'][x] > 0) this._rStore[y][x] /= this._cnt['r'][x];
            if (this._cnt['g'][x] > 0) this._gStore[y][x] /= this._cnt['g'][x];
            if (this._cnt['b'][x] > 0) this._bStore[y][x] /= this._cnt['b'][x];
          }

          this._renderRGBLine(y);

          this._lineY++;
          if (this.onStatus) this.onStatus(`line ${y}`);
          if (this._lineY >= h) {
            this._lineY = 0;
            if (this.onComplete) this.onComplete();
          }
        }
        else if (family === 'pd') {
          const y0 = y;
          const y1 = y + 1;

          this._yStore[y0] = new Float64Array(this._acc['y0']);
          this._yStore[y1] = new Float64Array(this._acc['y1']);
          this._crStore[y0] = new Float64Array(this._acc['cr']);
          this._cbStore[y0] = new Float64Array(this._acc['cb']);

          for (let x = 0; x < w; x++) {
            if (this._cnt['y0'][x] > 0) this._yStore[y0][x] /= this._cnt['y0'][x];
            if (this._cnt['y1'][x] > 0) this._yStore[y1][x] /= this._cnt['y1'][x];
            if (this._cnt['cr'][x] > 0) this._crStore[y0][x] /= this._cnt['cr'][x];
            if (this._cnt['cb'][x] > 0) this._cbStore[y0][x] /= this._cnt['cb'][x];
          }

          this._renderPDLine(y0);
          if (y1 < h) {
            this._renderPDLine(y1);
          }

          this._lineY += 2;
          if (this.onStatus) this.onStatus(`line ${y1}`);
          if (this._lineY >= h) {
            this._lineY = 0;
            if (this.onComplete) this.onComplete();
          }
        }
      }

      _renderRobotLine(y) {
        const w = this.mode.w;
        const Y = this._yStore[y];
        if (!Y) return;

        const even = y % 2 === 0 ? y : y - 1;
        const odd  = even + 1;
        const Cb = this._cbStore[even] || null;
        const Cr = this._crStore[odd]  || null;

        const row = new Uint8ClampedArray(w * 4);
        for (let x = 0; x < w; x++) {
          const luma = Y[x];
          const cb   = Cb ? Cb[x >> 1] : 128;
          const cr   = Cr ? Cr[x >> 1] : 128;

          row[x*4+0] = Math.max(0, Math.min(255, luma + 1.402  * (cr - 128)));
          row[x*4+1] = Math.max(0, Math.min(255, luma - 0.3441 * (cb - 128) - 0.7141 * (cr - 128)));
          row[x*4+2] = Math.max(0, Math.min(255, luma + 1.772  * (cb - 128)));
          row[x*4+3] = 255;
        }

        if (this.onLine) this.onLine(y, row);
      }

      _renderRobot24Line(y) {
        const w = this.mode.w;
        const Y = this._yStore[y];
        const Cb = this._cbStore[y];
        const Cr = this._crStore[y];
        if (!Y || !Cb || !Cr) return;

        const row = new Uint8ClampedArray(w * 4);
        for (let x = 0; x < w; x++) {
          const luma = Y[x];
          const cb = Cb[x >> 1];
          const cr = Cr[x >> 1];

          row[x*4+0] = Math.max(0, Math.min(255, luma + 1.402  * (cr - 128)));
          row[x*4+1] = Math.max(0, Math.min(255, luma - 0.3441 * (cb - 128) - 0.7141 * (cr - 128)));
          row[x*4+2] = Math.max(0, Math.min(255, luma + 1.772  * (cb - 128)));
          row[x*4+3] = 255;
        }

        if (this.onLine) this.onLine(y, row);
      }

      _renderRGBLine(y) {
        const w = this.mode.w;
        const R = this._rStore[y];
        const G = this._gStore[y];
        const B = this._bStore[y];
        if (!R || !G || !B) return;

        const row = new Uint8ClampedArray(w * 4);
        for (let x = 0; x < w; x++) {
          row[x*4+0] = R[x];
          row[x*4+1] = G[x];
          row[x*4+2] = B[x];
          row[x*4+3] = 255;
        }

        if (this.onLine) this.onLine(y, row);
      }

      _renderPDLine(y) {
        const w = this.mode.w;
        const Y = this._yStore[y];
        if (!Y) return;

        const yPairStart = y % 2 === 0 ? y : y - 1;
        const Cr = this._crStore[yPairStart];
        const Cb = this._cbStore[yPairStart];

        const row = new Uint8ClampedArray(w * 4);
        for (let x = 0; x < w; x++) {
          const luma = Y[x];
          const cr = Cr ? Cr[x] : 128;
          const cb = Cb ? Cb[x] : 128;

          row[x*4+0] = Math.max(0, Math.min(255, luma + 1.402  * (cr - 128)));
          row[x*4+1] = Math.max(0, Math.min(255, luma - 0.3441 * (cb - 128) - 0.7141 * (cr - 128)));
          row[x*4+2] = Math.max(0, Math.min(255, luma + 1.772  * (cb - 128)));
          row[x*4+3] = 255;
        }

        if (this.onLine) this.onLine(y, row);
      }
    }

    /* ---- RX start / stop ---- */
    function startRX() {
      if (state.rxActive) return;
      const sstvInputId = appCtx ? appCtx.audio.inputFor('sstv') : '';
      const audioConstraint = sstvInputId
        ? { deviceId: { exact: sstvInputId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false }).then(stream => {
        state.rxStream = stream;
        const ctx = getAudioCtx();
        const sr = ctx.sampleRate;

        // Clear canvas using active mode details
        const w = state.mode === 'auto' ? 320 : MODES[state.mode].w;
        const h = state.mode === 'auto' ? 240 : MODES[state.mode].h;
        state.rxCanvas.width = w;
        state.rxCanvas.height = h;

        const rctx = state.rxCanvas.getContext('2d');
        rctx.fillStyle = '#000';
        rctx.fillRect(0, 0, w, h);
        $('sstv-rx-lines').textContent = `0 / ${h}`;
        $('sstv-vis-code').textContent = state.mode === 'auto' ? 'Listening...' : 'Searching…';

        // Build decoder
        state.decoder = new SSTVDecoder(sr, state.mode, {
          onLine(y, rgba) {
            const currentW = state.decoder.mode ? state.decoder.mode.w : 320;
            const rctx = state.rxCanvas.getContext('2d');
            const imgData = new ImageData(new Uint8ClampedArray(rgba), currentW, 1);
            rctx.putImageData(imgData, 0, y);
            $('sstv-rx-lines').textContent = y + ' / ' + (state.decoder.mode ? (state.decoder.mode.h - 1) : 239);
          },
          onComplete() {
            $('sstv-vis-code').textContent = 'Complete';
            finishRxImage();
          },
          onStatus(msg) {
            $('sstv-rx-snr').textContent = msg;
          },
          onModeDetected(visCode) {
            const matchedKey = Object.keys(MODES).find(k => MODES[k].vis === visCode);
            if (matchedKey) {
              const matchedMode = MODES[matchedKey];
              $('sstv-vis-code').textContent = `${matchedMode.name} (VIS ${visCode})`;
              
              // Configure receiver to this mode
              state.mode = matchedKey;
              $('sstv-mode-select').value = matchedKey;
              $('sstv-mode-display').textContent = matchedMode.name;
              
              // Configure canvas sizes
              configureCanvasesForMode(matchedKey);
              
              // Reset decoder to this mode and jump straight to line decoding (skip first sync since we aligned at VIS stop)
              state.decoder.setMode(matchedKey);
              state.decoder._state = 'DECODE_LINE';
              state.decoder._currentSegmentIdx = 0;
              state.decoder._segmentSampleCount = 0;
              state.decoder._lineY = 0;
            }
          }
        });

        // ScriptProcessorNode gives us raw PCM per callback
        state.rxSourceNode = ctx.createMediaStreamSource(stream);
        state.rxProcessor  = ctx.createScriptProcessor(4096, 1, 1);
        state.rxProcessor.onaudioprocess = e => {
          if (!state.rxActive) return;
          state.decoder.process(e.inputBuffer.getChannelData(0));
        };
        state.rxSourceNode.connect(state.rxProcessor);
        state.rxProcessor.connect(ctx.destination);

        state.rxActive = true;
        $('sstv-audio-status').textContent = 'Listening (' + sr + ' Hz)';
        $('sstv-status-badge').textContent = 'RX Active';
        $('sstv-rx-start-btn').disabled = true;
        $('sstv-rx-stop-btn').disabled  = false;
        $('sstv-rx-save-btn').disabled  = false;
        $('sstv-log-rx-btn').disabled   = false;
      }).catch(err => {
        alert('Microphone access denied: ' + err.message);
      });
    }

    function stopRX() {
      state.rxActive = false;
      if (state.rxProcessor)  { state.rxProcessor.disconnect(); state.rxProcessor = null; }
      if (state.rxSourceNode) { state.rxSourceNode.disconnect(); state.rxSourceNode = null; }
      if (state.rxStream)     { state.rxStream.getTracks().forEach(t => t.stop()); state.rxStream = null; }
      $('sstv-audio-status').textContent = 'Off';
      $('sstv-status-badge').textContent = 'Idle';
      $('sstv-vis-code').textContent = '—';
      $('sstv-rx-start-btn').disabled = false;
      $('sstv-rx-stop-btn').disabled  = true;
    }

    function finishRxImage() {
      const dataURL = state.rxCanvas.toDataURL('image/png');
      const ts = new Date().toLocaleTimeString();
      state.gallery.push({ dataURL, ts });
      $('sstv-gallery-count').textContent = state.gallery.length + ' image' + (state.gallery.length !== 1 ? 's' : '');
      const gallery = $('sstv-gallery');
      if (state.gallery.length === 1) gallery.innerHTML = '';
      const item = document.createElement('div');
      const img  = document.createElement('img');
      img.src = dataURL;
      img.style.cssText = 'width:100%;border-radius:4px;border:1px solid var(--panel-border);display:block;';
      img.title = 'Received ' + ts;
      const lbl = document.createElement('div');
      lbl.textContent = ts;
      lbl.style.cssText = 'font-size:10px;color:var(--muted);text-align:center;margin-top:.2rem;';
      item.appendChild(img); item.appendChild(lbl);
      gallery.appendChild(item);
    }

    /* ===================================================
       ENCODER — generic multi-mode phase-continuous encoder
       =================================================== */
    function encodeSSTV(imageData, modeId) {
      const m = MODES[modeId] || MODES.robot36;
      const { data, width, height } = imageData;
      const W = m.w;
      const H = m.h;
      const sr = state.audioCtx ? state.audioCtx.sampleRate : 44100;

      const n = ms => Math.round(ms * sr / 1000);
      
      const LEADER_N  = n(300);
      const BREAK_N   = n(10);
      const VIS_BIT_N = n(30);
      
      const linesCount = (m.family === 'pd') ? H / 2 : H;
      
      let lineSegments = [];
      if (m.family === 'robot') {
        lineSegments = [
          { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
          { type: 'porch', len: n(m.porchMs), hz: 1500 },
          { type: 'y',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
          { type: 'c',     len: n(m.cMs) }
        ];
      } else if (m.family === 'robot24') {
        lineSegments = [
          { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
          { type: 'porch', len: n(m.porchMs), hz: 1500 },
          { type: 'y',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
          { type: 'cb',    len: n(m.cMs) },
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
          { type: 'cr',    len: n(m.cMs) }
        ];
      } else if (m.family === 'martin') {
        lineSegments = [
          { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
          { type: 'porch', len: n(m.porchMs), hz: 1500 },
          { type: 'g',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
          { type: 'b',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
          { type: 'r',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 }
        ];
      } else if (m.family === 'scottie') {
        lineSegments = [
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
          { type: 'g',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.sepMs),   hz: 1500 },
          { type: 'b',     len: n(m.yMs) },
          { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
          { type: 'porch', len: n(m.porchMs), hz: 1500 },
          { type: 'r',     len: n(m.yMs) }
        ];
      } else if (m.family === 'pd') {
        lineSegments = [
          { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
          { type: 'porch', len: n(m.porchMs), hz: 1500 },
          { type: 'y0',    len: n(m.yMs) },
          { type: 'cr',    len: n(m.yMs) },
          { type: 'cb',    len: n(m.yMs) },
          { type: 'y1',    len: n(m.yMs) }
        ];
      } else if (m.family === 'pasokon') {
        lineSegments = [
          { type: 'sync',  len: n(m.syncMs),  hz: 1200 },
          { type: 'porch', len: n(m.porchMs), hz: 1500 },
          { type: 'r',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.porchMs), hz: 1500 },
          { type: 'g',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.porchMs), hz: 1500 },
          { type: 'b',     len: n(m.yMs) },
          { type: 'sep',   len: n(m.porchMs), hz: 1500 }
        ];
      }

      let lineLen = 0;
      lineSegments.forEach(s => lineLen += s.len);

      const SCOTTIE_START_SYNC_N = (m.family === 'scottie') ? n(9.0) : 0;

      const total = LEADER_N + BREAK_N + LEADER_N + VIS_BIT_N * 11 + SCOTTIE_START_SYNC_N + linesCount * lineLen + n(500);
      const buf = new Float32Array(total);
      let off = 0;
      let phase = 0;

      const tone = (hz, count) => {
        const dph = 2 * Math.PI * hz / sr;
        for (let i = 0; i < count && off < buf.length; i++) {
          buf[off++] = 0.9 * Math.sin(phase);
          phase += dph;
        }
      };

      // VIS header
      tone(1900, LEADER_N);
      tone(1200, BREAK_N);
      tone(1900, LEADER_N);
      tone(1200, VIS_BIT_N);

      const vis = m.vis;
      let parity = 0;
      for (let b = 0; b < 7; b++) {
        const bit = (vis >> b) & 1;
        parity ^= bit;
        tone(bit ? 1100 : 1300, VIS_BIT_N);
      }
      tone(parity ? 1100 : 1300, VIS_BIT_N);
      tone(1200, VIS_BIT_N);

      if (SCOTTIE_START_SYNC_N > 0) {
        tone(1200, SCOTTIE_START_SYNC_N);
      }

      const getPixelRGB = (px, py) => {
        const sx = Math.floor(px * width / W);
        const sy = Math.floor(py * height / H);
        const idx = (sy * width + sx) * 4;
        return {
          r: data[idx],
          g: data[idx+1],
          b: data[idx+2]
        };
      };

      for (let lineIndex = 0; lineIndex < linesCount; lineIndex++) {
        const y = (m.family === 'pd') ? lineIndex * 2 : lineIndex;

        lineSegments.forEach(seg => {
          if (seg.hz !== undefined) {
            tone(seg.hz, seg.len);
          } else {
            const len = seg.len;
            for (let i = 0; i < len && off < buf.length; i++) {
              const segmentWidth = (seg.type === 'c' || seg.type === 'cb' || seg.type === 'cr') ? (W / 2) : W;
              const x = Math.floor(i * segmentWidth / len);
              
              let hz = 1500;
              
              if (seg.type === 'y') {
                const rgb = getPixelRGB(x, y);
                const luma = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
                hz = 1500 + (luma / 255) * 800;
              } else if (seg.type === 'c') {
                const isEven = (y % 2 === 0);
                const rgb = getPixelRGB(x * 2, y);
                const chroma = isEven
                  ? Math.max(0, Math.min(255, -0.16874*rgb.r - 0.33126*rgb.g + 0.5*rgb.b + 128))
                  : Math.max(0, Math.min(255,  0.5*rgb.r - 0.41869*rgb.g - 0.08131*rgb.b + 128));
                hz = 1500 + (chroma / 255) * 800;
              } else if (seg.type === 'r') {
                const rgb = getPixelRGB(x, y);
                hz = 1500 + (rgb.r / 255) * 800;
              } else if (seg.type === 'g') {
                const rgb = getPixelRGB(x, y);
                hz = 1500 + (rgb.g / 255) * 800;
              } else if (seg.type === 'b') {
                const rgb = getPixelRGB(x, y);
                hz = 1500 + (rgb.b / 255) * 800;
              } else if (seg.type === 'y0') {
                const rgb = getPixelRGB(x, y);
                const luma = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
                hz = 1500 + (luma / 255) * 800;
              } else if (seg.type === 'y1') {
                const rgb = getPixelRGB(x, y + 1);
                const luma = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
                hz = 1500 + (luma / 255) * 800;
              } else if (seg.type === 'cr') {
                const rgbA = getPixelRGB(x, y);
                const rgbB = getPixelRGB(x, y + 1);
                const crA = 0.5*rgbA.r - 0.41869*rgbA.g - 0.08131*rgbA.b + 128;
                const crB = 0.5*rgbB.r - 0.41869*rgbB.g - 0.08131*rgbB.b + 128;
                const cr = Math.max(0, Math.min(255, (crA + crB) / 2));
                hz = 1500 + (cr / 255) * 800;
              } else if (seg.type === 'cb') {
                const rgbA = getPixelRGB(x, y);
                const rgbB = getPixelRGB(x, y + 1);
                const cbA = -0.16874*rgbA.r - 0.33126*rgbA.g + 0.5*rgbA.b + 128;
                const cbB = -0.16874*rgbB.r - 0.33126*rgbB.g + 0.5*rgbB.b + 128;
                const cb = Math.max(0, Math.min(255, (cbA + cbB) / 2));
                hz = 1500 + (cb / 255) * 800;
              }

              buf[off++] = 0.9 * Math.sin(phase);
              phase += 2 * Math.PI * hz / sr;
            }
          }
        });
      }

      const filledEnd = Math.min(off + n(500), buf.length);
      const out = buf.subarray(0, filledEnd);
      // Timing metadata so the TX scan-line can map playback time -> image row.
      out.__meta = {
        sr,
        headerN: LEADER_N + BREAK_N + LEADER_N + VIS_BIT_N * 11 + SCOTTIE_START_SYNC_N,
        videoN: linesCount * lineLen,
        height: H
      };
      return out;
    }

    async function transmitImage() {
      if (state.txActive) return;
      if (state.mode === 'auto') {
        alert('Cannot transmit in Auto-Detect mode. Please choose a specific mode first.');
        return;
      }
      const canvas = state.txCanvas;
      renderEditorLayersToCanvas(canvas);
      const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

      const audioCtx = getAudioCtx();
      const pcm = encodeSSTV(imgData, state.mode);
      const txMeta = pcm.__meta;
      const audioBuf = audioCtx.createBuffer(1, pcm.length, audioCtx.sampleRate);
      audioBuf.getChannelData(0).set(pcm);

      const src = audioCtx.createBufferSource();
      src.buffer = audioBuf;

      const outputDeviceId = appCtx ? appCtx.audio.outputFor('sstv') : '';
      if (outputDeviceId && typeof HTMLAudioElement.prototype.setSinkId === 'function') {
        const dest = audioCtx.createMediaStreamDestination();
        src.connect(dest);
        const sinkEl = new Audio();
        sinkEl.srcObject = dest.stream;
        try { await sinkEl.setSinkId(outputDeviceId); } catch (_) {}
        await sinkEl.play().catch(() => {});
        state.txSinkEl = sinkEl;
      } else {
        src.connect(audioCtx.destination);
      }

      state.txActive = true;
      state.txSource = src;
      $('sstv-tx-start-btn').disabled = true;
      $('sstv-tx-stop-btn').disabled  = false;
      $('sstv-status-badge').textContent = 'TX Active';
      
      const durationS = Math.round(pcm.length / audioCtx.sampleRate);
      $('sstv-tx-progress').textContent  = `Sending… (~${durationS}s)`;

      src.start();
      const startedAt = audioCtx.currentTime;
      startTxScanLine(canvas, imgData, txMeta, startedAt, audioCtx);
      src.onended = () => {
        state.txActive = false;
        stopTxScanLine(canvas, imgData);
        if (state.txSinkEl) { state.txSinkEl.pause(); state.txSinkEl = null; }
        $('sstv-tx-start-btn').disabled = false;
        $('sstv-tx-stop-btn').disabled  = true;
        $('sstv-status-badge').textContent = 'Idle';
        $('sstv-tx-progress').textContent  = 'Done';
      };
    }

    /* TX scan-line overlay — follows the row being transmitted, phone-radio style. */
    function startTxScanLine(canvas, imgData, meta, startedAt, audioCtx) {
      stopTxScanLine();
      if (!meta) return;
      const ctx = canvas.getContext('2d');
      const { sr, headerN, videoN, height } = meta;
      const step = () => {
        if (!state.txActive) return;
        const elapsedN = (audioCtx.currentTime - startedAt) * sr;
        ctx.putImageData(imgData, 0, 0);          // restore clean frame
        const into = elapsedN - headerN;          // samples into the video portion
        if (into >= 0 && into <= videoN) {
          const y = Math.min(height - 1, (into / videoN) * height);
          ctx.save();
          ctx.shadowColor = 'rgba(255,255,255,.9)';
          ctx.shadowBlur = 6;
          ctx.strokeStyle = 'rgba(255,255,255,.95)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(0, y + 0.5);
          ctx.lineTo(canvas.width, y + 0.5);
          ctx.stroke();
          ctx.restore();
        }
        state.txScanRaf = requestAnimationFrame(step);
      };
      state.txScanRaf = requestAnimationFrame(step);
    }

    function stopTxScanLine(canvas, imgData) {
      if (state.txScanRaf) { cancelAnimationFrame(state.txScanRaf); state.txScanRaf = null; }
      if (canvas && imgData) canvas.getContext('2d').putImageData(imgData, 0, 0);
    }

    function stopTX() {
      if (state.txSource) { try { state.txSource.stop(); } catch(_) {} state.txSource = null; }
      if (state.txSinkEl) { state.txSinkEl.pause(); state.txSinkEl = null; }
      state.txActive = false;
      stopTxScanLine();
      $('sstv-tx-start-btn').disabled = false;
      $('sstv-tx-stop-btn').disabled  = true;
      $('sstv-status-badge').textContent = 'Idle';
      $('sstv-tx-progress').textContent  = 'Aborted';
    }

    /* ===== EDITOR ===== */
    function renderEditorLayersToCanvas(target) {
      const src = state.txCanvas;
      const ctx = target.getContext('2d');
      ctx.drawImage(src, 0, 0, target.width, target.height);
      for (const layer of state.layers) {
        const expanded = expandTemplates(layer.text);
        ctx.save();
        ctx.font = `bold ${layer.size}px ${layer.font}`;
        ctx.fillStyle = layer.shadow;
        ctx.fillText(expanded, layer.x + 1, layer.y + 1);
        ctx.fillStyle = layer.color;
        ctx.fillText(expanded, layer.x, layer.y);
        ctx.restore();
      }
    }

    function refreshEditorCanvas() {
      renderEditorLayersToCanvas(state.editorCanvas);
      renderLayerList();
    }

    function renderLayerList() {
      const list = $('sstv-layer-list');
      list.innerHTML = '';
      state.layers.forEach((layer, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:.38rem;font-size:12px;';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);';
        lbl.textContent = `[${i+1}] "${layer.text}" @ ${layer.x},${layer.y}`;
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '✕';
        del.className = 'secondary';
        del.style.cssText = 'padding:.15rem .4rem;font-size:11px;min-width:auto;';
        del.onclick = () => { state.layers.splice(i, 1); refreshEditorCanvas(); };
        row.appendChild(lbl);
        row.appendChild(del);
        list.appendChild(row);
      });
    }

    function addTextLayer() {
      const text   = $('sstv-overlay-text').value || '{CALL} de {MYCALL}';
      const size   = parseInt($('sstv-font-size').value) || 22;
      const color  = $('sstv-font-color').value || '#ffffff';
      const shadow = $('sstv-shadow-color').value || '#000000';
      const font   = $('sstv-font-family').value || 'JetBrains Mono, monospace';
      const x      = parseInt($('sstv-overlay-x').value) || 10;
      const y      = parseInt($('sstv-overlay-y').value) || 220;
      state.layers.push({ text, size, color, shadow, font, x, y });
      refreshEditorCanvas();
    }

    function loadImageToCanvas(file) {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const ctx = state.txCanvas.getContext('2d');
          ctx.drawImage(img, 0, 0, state.txCanvas.width, state.txCanvas.height);
          refreshEditorCanvas();
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    function saveToSlot() {
      const slot = $('sstv-apply-slot-select').value;
      const w = state.txCanvas.width;
      const h = state.txCanvas.height;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      renderEditorLayersToCanvas(off);
      state.slots[slot] = off.toDataURL('image/png');
    }

    function selectPresetSlot(slot) {
      state.activeEditorSlot = slot;
      $('sstv-editor-active-slot').textContent = slot.toUpperCase();
      const w = state.txCanvas.width;
      const h = state.txCanvas.height;
      
      if (state.slots[slot]) {
        const img = new Image();
        img.onload = () => {
          const ctx = state.txCanvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          refreshEditorCanvas();
        };
        img.src = state.slots[slot];
      } else {
        const ctx = state.txCanvas.getContext('2d');
        const colors = { cq:'#1a3a1a', qrz:'#1a1a3a', '73':'#2a1a10', qsl:'#2a1a2a', custom:'#111' };
        ctx.fillStyle = colors[slot] || '#111';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(h * 0.15)}px JetBrains Mono, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(slot.toUpperCase(), w / 2, h / 2);
        refreshEditorCanvas();
      }
    }

    /* ===== WIRE-UP ===== */
    function initSSTVHandlers() {
      initRefs();

      $('sstv-rx-start-btn').addEventListener('click', startRX);
      $('sstv-rx-stop-btn').addEventListener('click', stopRX);
      $('sstv-tx-start-btn').addEventListener('click', () => {
        if (confirm('Transmit SSTV image via audio output?')) transmitImage();
      });
      $('sstv-tx-stop-btn').addEventListener('click', stopTX);

      $('sstv-mode-select').addEventListener('change', e => {
        state.mode = e.target.value;
        $('sstv-mode-display').textContent = MODES[state.mode]?.name || 'Auto-Detect';
        if (state.mode !== 'auto') {
          configureCanvasesForMode(state.mode);
        }
        if (state.decoder) {
          state.decoder.setMode(state.mode);
        }
        $('sstv-tx-start-btn').disabled = (state.mode === 'auto');
      });

      $('sstv-add-text-btn').addEventListener('click', addTextLayer);
      $('sstv-clear-text-btn').addEventListener('click', () => { state.layers = []; refreshEditorCanvas(); });
      $('sstv-apply-to-slot-btn').addEventListener('click', saveToSlot);

      // The visible button and the hidden file input it opens. This was an
      // inline `onclick="document.getElementById(...).click()"` in index.html —
      // the last inline handler in the app, and the only reason the CSP still
      // needed 'unsafe-inline' in script-src.
      $('sstv-load-image-btn')?.addEventListener('click', () => $('sstv-load-image').click());
      $('sstv-load-image').addEventListener('change', e => {
        if (e.target.files[0]) loadImageToCanvas(e.target.files[0]);
      });

      $('sstv-rx-save-btn').addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = state.rxCanvas.toDataURL('image/png');
        a.download = 'sstv-rx-' + Date.now() + '.png';
        a.click();
      });

      $('sstv-rx-clear-btn').addEventListener('click', () => {
        const w = state.rxCanvas.width;
        const h = state.rxCanvas.height;
        const ctx = state.rxCanvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        if (state.decoder) state.decoder._reset();
        $('sstv-rx-lines').textContent = `0 / ${h}`;
        $('sstv-vis-code').textContent = '—';
      });

      $('sstv-preview-audio-btn').addEventListener('click', () => {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        osc.frequency.value = 1900;
        osc.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 2);
      });

      $('sstv-capture-btn').addEventListener('click', () => {
        alert('Screen capture: use browser\'s built-in screenshot tool, then load it with "Load Image".');
      });

      document.querySelectorAll('.sstv-preset-tab').forEach(btn => {
        btn.addEventListener('click', () => selectPresetSlot(btn.dataset.slot));
      });

      let dragging = null;
      state.editorCanvas.addEventListener('mousedown', e => {
        if (state.layers.length === 0) return;
        const rect = state.editorCanvas.getBoundingClientRect();
        const w = state.editorCanvas.width;
        const h = state.editorCanvas.height;
        const scaleX = w / rect.width, scaleY = h / rect.height;
        const mx = (e.clientX - rect.left) * scaleX, my = (e.clientY - rect.top) * scaleY;
        
        let best = null, bestDist = Infinity;
        state.layers.forEach((l, i) => {
          const d = Math.hypot(l.x - mx, l.y - my);
          if (d < bestDist) { bestDist = d; best = i; }
        });
        if (bestDist < 60) { dragging = best; }
      });
      
      state.editorCanvas.addEventListener('mousemove', e => {
        if (dragging === null) return;
        const rect = state.editorCanvas.getBoundingClientRect();
        const w = state.editorCanvas.width;
        const h = state.editorCanvas.height;
        const scaleX = w / rect.width, scaleY = h / rect.height;
        state.layers[dragging].x = Math.round((e.clientX - rect.left) * scaleX);
        state.layers[dragging].y = Math.round((e.clientY - rect.top) * scaleY);
        $('sstv-overlay-x').value = state.layers[dragging].x;
        $('sstv-overlay-y').value = state.layers[dragging].y;
        refreshEditorCanvas();
      });
      state.editorCanvas.addEventListener('mouseup', () => { dragging = null; });

      // Disable TX button initially since mode is auto
      $('sstv-tx-start-btn').disabled = true;
      $('sstv-mode-display').textContent = 'Auto-Detect';

      // Initial TX canvas sizes and placeholder
      configureCanvasesForMode('robot36'); // Default editor canvas sizes to Robot 36 at init
      selectPresetSlot('cq');

      const sstvInputSel  = $('sstv-audio-input-select');
      const sstvOutputSel = $('sstv-audio-output-select');
      if (sstvInputSel) {
        sstvInputSel.addEventListener('change', () => {
          if (appCtx) {
            appCtx.audio.getConfig().perApp.sstv.input = sstvInputSel.value;
            appCtx.audio.saveDeviceConfig();
          }
        });
      }
      if (sstvOutputSel) {
        sstvOutputSel.addEventListener('change', () => {
          if (appCtx) {
            appCtx.audio.getConfig().perApp.sstv.output = sstvOutputSel.value;
            appCtx.audio.saveDeviceConfig();
          }
        });
      }
    }

    export default {
      id: "sstv",
      title: "SSTV",
      // mount() runs after main.js (a deferred module) executes, i.e. after
      // DOM parsing completes — the same point at which the original inline
      // module script ran (readyState was already past 'loading' by then,
      // so the old `document.readyState === 'loading'` branch never actually
      // fired in practice; the else branch — calling initSSTVHandlers()
      // immediately — is what always ran). initSSTVHandlers() is called
      // exactly once here, same as before, and does not depend on anything
      // that only becomes true after DOMContentLoaded specifically (it only
      // needs the DOM nodes it queries by id to already exist, which they
      // do by mount time).
      mount(panelEl, ctx) {
        appCtx = ctx;
        initSSTVHandlers();
      }
    };
