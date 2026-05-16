// ─── packages/eris/events/messageCreate/unicode.js ──────────────────────────
// Unicode Normalizer — converts decorative Discord fonts to readable ASCII.
// Handles: Fraktur, Double-struck, Bold, Script, Sans, Monospace, Fullwidth,
// Small Caps, Subscript, Superscript, Circled, and other fancy Unicode blocks.

const _unicodeMap = (() => {
  const m = new Map();
  const az = "abcdefghijklmnopqrstuvwxyz";
  const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  // Small caps → lowercase
  const sc = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ";
  for (let i = 0; i < sc.length; i++) m.set(sc[i], az[i]);
  // Subscript letters
  const sub = [["ₐ","a"],["ₑ","e"],["ₕ","h"],["ᵢ","i"],["ⱼ","j"],["ₖ","k"],["ₗ","l"],["ₘ","m"],["ₙ","n"],["ₒ","o"],["ₚ","p"],["ᵣ","r"],["ₛ","s"],["ₜ","t"],["ᵤ","u"],["ᵥ","v"],["ₓ","x"]];
  for (const [k, v] of sub) m.set(k, v);
  // Superscript letters
  const sup = [["ᵃ","a"],["ᵇ","b"],["ᶜ","c"],["ᵈ","d"],["ᵉ","e"],["ᶠ","f"],["ᵍ","g"],["ʰ","h"],["ⁱ","i"],["ʲ","j"],["ᵏ","k"],["ˡ","l"],["ᵐ","m"],["ⁿ","n"],["ᵒ","o"],["ᵖ","p"],["ʳ","r"],["ˢ","s"],["ᵗ","t"],["ᵘ","u"],["ᵛ","v"],["ʷ","w"],["ˣ","x"],["ʸ","y"],["ᶻ","z"]];
  for (const [k, v] of sup) m.set(k, v);
  // Parenthesized/circled letters
  for (let i = 0; i < 26; i++) { m.set(String.fromCodePoint(0x249C + i), az[i]); m.set(String.fromCodePoint(0x24B6 + i), AZ[i]); m.set(String.fromCodePoint(0x24D0 + i), az[i]); }
  // Common lookalikes from other scripts (Greek, Cyrillic, etc.)
  const lookalikes = [["α","a"],["β","b"],["є","e"],["η","n"],["ι","i"],["σ","o"],["τ","t"],["υ","u"],["ν","v"],["ω","w"],["ρ","p"],["γ","y"],["д","d"],["к","k"],["м","m"],["н","h"],["р","p"],["с","c"],["у","y"],["х","x"]];
  for (const [k, v] of lookalikes) m.set(k, v);
  return m;
})();

export function normalizeUnicode(text) {
  if (!text) return text;
  // Fast path: skip normalization for pure ASCII (most messages)
  if (/^[\x20-\x7E\n\r\t]+$/.test(text)) return text;
  // First pass: NFKC handles Fraktur, Double-struck, Bold, Fullwidth, etc.
  let result = text.normalize("NFKC");
  // Second pass: map remaining decorative chars the normalizer missed
  let out = "";
  for (const ch of result) {
    out += _unicodeMap.get(ch) || ch;
  }
  return out;
}
