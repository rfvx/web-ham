# Slow Scan Television (SSTV) Implementation in Web Ham Logger

This document provides a technical overview of the SSTV subsystem in Web Ham Logger. The implementation is entirely client-side, running in-browser using the Web Audio API and standard HTML5 Canvas.

---

## 1. Subsystem Architecture

The SSTV system consists of three main parts:
1. **The Signal Demodulator & Zero-Crossing Freq Estimator**: For decoding audio signals in real time.
2. **The Segment-Based Decoder**: A unified state machine that uses timing profiles to construct images.
3. **The VIS (Vertical Interval Signaling) Auto-Detector**: For automatically identifying transmission modes.
4. **The Generic Encoder**: For compiling canvas images into phase-continuous audio waveforms.

```mermaid
graph TD
    subgraph Receiver (RX)
        Mic[Microphone Input] --> HP[High-pass Filter 500 Hz]
        HP --> LP[Low-pass Filter 3000 Hz]
        LP --> ZC[Zero-Crossing period to Hz]
        ZC --> VIS[VIS Detector]
        ZC --> Dec[Segment Decoder]
        VIS -- mode detected --> Dec
        Dec --> CanvasRX[RX Canvas]
    end
    subgraph Transmitter (TX)
        CanvasTX[TX Canvas] --> Enc[SSTV Encoder]
        Enc --> PCM[Audio Buffer]
        PCM --> Spk[Speaker Output]
    end
```

---

## 2. DSP & Demodulation (Decoding)

### Bandpass Filter
A software bandpass filter is implemented using recursive Infinite Impulse Response (IIR) filters to isolate the SSTV sub-carrier frequencies (1100 Hz to 2300 Hz) and suppress noise/DC offset:
- **High-pass Filter (cutoff 500 Hz)**: Removes low-frequency hum and DC offset.
- **Low-pass Filter (cutoff 3000 Hz)**: Removes high-frequency noise and harmonics.

### Zero-Crossing Period Estimator
Instead of a computationally heavy FFT or sliding Goertzel algorithm, the demodulator tracks the time between rising zero-crossings of the filtered signal to determine the instantaneous frequency:
1. When the waveform crosses zero from negative to positive, a crossing time `t` is calculated.
2. **Sub-sample Interpolation**: To avoid quantization errors from the discrete sampling clock, the exact crossing time is linearly interpolated between the negative sample and positive sample.
3. The frequency is calculated as:
   $$\text{Frequency (Hz)} = \frac{\text{Sample Rate}}{\Delta t}$$

---

## 3. Mode Specifications & Timing Profiles

SSTV modes are grouped into families sharing similar color space formats and segment layouts.

### Supported Modes

| Family | Mode | VIS Code | Resolution | Transmission Time | Color Space |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Robot** | Robot 24 | 10 | 160 × 120 | ~24s | YCbCr (4:2:2) |
| | Robot 36 | 8 | 320 × 240 | ~36s | YCbCr (4:2:0) |
| | Robot 72 | 12 | 320 × 240 | ~72s | YCbCr (4:2:0) |
| **Martin** | Martin M1 | 44 | 320 × 256 | ~114s | RGB (G-B-R) |
| | Martin M2 | 40 | 320 × 256 | ~58s | RGB (G-B-R) |
| **Scottie** | Scottie S1 | 60 | 320 × 256 | ~110s | RGB (G-B-R) |
| | Scottie S2 | 56 | 320 × 256 | ~71s | RGB (G-B-R) |
| | Scottie DX | 76 | 320 × 256 | ~268s | RGB (G-B-R) |
| **PD** | PD-50 | 93 | 320 × 256 | ~50s | YCbCr (4:2:0) |
| | PD-90 | 99 | 320 × 256 | ~90s | YCbCr (4:2:0) |
| | PD-120 | 95 | 640 × 496 | ~126s | YCbCr (4:2:0) |
| | PD-160 | 98 | 512 × 400 | ~161s | YCbCr (4:2:0) |
| | PD-180 | 96 | 640 × 496 | ~187s | YCbCr (4:2:0) |
| | PD-240 | 97 | 640 × 496 | ~248s | YCbCr (4:2:0) |
| **Pasokon** | Pasokon P3 | 113 | 640 × 496 | ~203s | RGB (R-G-B) |
| | Pasokon P5 | 114 | 640 × 496 | ~305s | RGB (R-G-B) |
| | Pasokon P7 | 115 | 640 × 496 | ~406s | RGB (R-G-B) |

---

## 4. Segment-Based Line State Machine

Rather than implementing separate decoders/encoders for each mode, Web Ham Logger uses a unified **Segment Profile**. A scan line is represented as a list of segments, each having a type and duration.

### Segment Types
- `sync`: Sync pulse (1200 Hz)
- `porch`: Black porch / back porch (1500 Hz)
- `sep`: Color component separator (1500 Hz)
- `y` / `y0` / `y1`: Luminance (Y) video scan
- `c` / `cr` / `cb`: Chrominance (Cb, Cr) video scan
- `r` / `g` / `b`: Red, Green, Blue video scan

### Line Structures by Family
- **Robot (YCrCb sequential)**: `[sync, porch, luma_Y, separator, chroma_C]`
- **Martin (RGB sequential)**: `[sync, porch, green_G, separator, blue_B, separator, red_R, separator]`
- **Scottie (RGB inline sync)**: `[separator, green_G, separator, blue_B, sync, porch, red_R]`
- **PD (Double-Line YCrCb)**: `[sync, porch, luma_Y0, chroma_Cr, chroma_Cb, luma_Y1]`
- **Pasokon (RGB sequential)**: `[sync, porch, red_R, separator, green_G, separator, blue_B, separator]`

During line decoding, the demodulated frequency (Hz) is mapped to pixel value `(hz - 1500) / 800 * 255` and written to the corresponding pixel column `x` in the active segment's accumulator.

---

## 5. VIS Auto-Detection

Before image data begins, a digital handshake header is transmitted:
1. **Leader Tone**: 1900 Hz for 300 ms.
2. **Break Tone**: 1200 Hz for 10 ms.
3. **Leader Tone**: 1900 Hz for 300 ms.
4. **VIS Start Bit**: 1200 Hz for 30 ms.
5. **VIS Data**: 7 data bits LSB-first + 1 even-parity bit (30 ms each; 1100 Hz = `1`, 1300 Hz = `0`).
6. **VIS Stop Bit**: 1200 Hz for 30 ms.

### Detection State Machine
- When in "Auto-Detect" mode, a state machine monitors the incoming frequency stream.
- When `Leader 1 -> Break -> Leader 2` is detected and a transition to the 1200 Hz start bit occurs, the system starts buffering incoming frequency samples for exactly 300 ms.
- The 300 ms buffer is divided into 10 equal bins (30 ms each):
  - Bin 0 (Start) and Bin 9 (Stop) are verified to be 1200 Hz.
  - Bins 1-8 are averaged: if the average frequency is $< 1200\text{ Hz}$, the bit is `1`; otherwise `0`.
  - The even parity is computed. If the parity is valid, or if the code matches a known mode exactly, the decoder immediately configures itself to the detected mode and begins line sync decoding.

---

## 6. Phase-Continuous Waveform Generation (Encoding)

During transmission (TX), the encoder reads the pixel data from the TX Canvas, processes it according to the selected mode's segment structure, and generates audio samples.

To prevent high-frequency clicking and pops that would distort the signal and break synchronization on the receiving end, the encoder maintains **phase continuity** across all segment boundaries:
```javascript
// Phase-continuous tone generation
const tone = (hz, count) => {
  const dph = 2 * Math.PI * hz / sampleRate;
  for (let i = 0; i < count; i++) {
    buffer[offset++] = 0.9 * Math.sin(phase);
    phase += dph;
  }
};
```
For video segments, the target sub-carrier frequency is computed for each sample based on the pixel value, and the phase is incremented dynamically:
```javascript
const luma = 0.299 * r + 0.587 * g + 0.114 * b;
const hz = 1500 + (luma / 255) * 800;
buffer[offset++] = 0.9 * Math.sin(phase);
phase += 2 * Math.PI * hz / sampleRate;
```
This guarantees a perfectly smooth FM waveform.
