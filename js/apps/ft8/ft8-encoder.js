const DEFAULT_SAMPLE_RATE = 12000;

export function createFt8Encoder(backend) {
  if (!backend || typeof backend.encode !== "function") {
    throw new Error("FT8 encoder backend is unavailable.");
  }

  return {
    backend: "ft8play-compatible",
    sampleRate: DEFAULT_SAMPLE_RATE,
    async encodeMessage(text, options = {}) {
      const normalizedText = String(text || "").trim().toUpperCase();
      if (!normalizedText) {
        throw new Error("FT8 message text is required.");
      }

      const toneHz = clampTone(options.toneHz);
      const waveform = await backend.encode(normalizedText, toneHz);
      if (!(waveform instanceof Float32Array) || waveform.length === 0) {
        throw new Error("The FT8 encoder backend returned no waveform samples.");
      }

      return {
        text: normalizedText,
        toneHz,
        sampleRate: DEFAULT_SAMPLE_RATE,
        waveform,
        durationSeconds: waveform.length / DEFAULT_SAMPLE_RATE
      };
    }
  };
}

function clampTone(value) {
  if (!Number.isFinite(value)) {
    return 1500;
  }

  return Math.min(3000, Math.max(200, Math.round(value)));
}
