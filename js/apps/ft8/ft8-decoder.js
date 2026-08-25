const FT8JS_URL = new URL("../../../vendor/ft8js/index.js", import.meta.url).href;

let decoderPromise = null;

export async function loadFt8Decoder() {
  if (!decoderPromise) {
    decoderPromise = import(FT8JS_URL);
  }

  const module = await decoderPromise;
  return {
    decode: module.decode,
    encode: module.encode
  };
}
