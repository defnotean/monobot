/** @param {string} text */
export function getSlangGuardContext(text) {
  const lower = (text || "").toLowerCase();
  
  // Ignore normal meanings like crack jokes, crack the code, or cracking up
  if (/\bcrack(?:ing)?\s+(?:a\s+)?(?:joke|the\s+code|up|open|a\s+smile)\b/.test(lower)) {
    return null;
  }

  // Detect "let him crack", "he's cracked", "cracking at", etc.
  if (/\b(?:let|watch)\s+(?:him|her|them|bro|brotha|blud|my\s+guy)\s+crack\b/.test(lower) || 
      /\b(?:he|she|they|bro|blud|my\s+guy)\s+(?:is|was)\s+crack(?:ing|ed)?\b/.test(lower) || 
      /\b(?:you|u)\s+(?:are|r)\s+crack(?:ing|ed)?\b/.test(lower) ||
      /\b(?:fucking|super)\s+crack(?:ed|ing)?\b/.test(lower)) {
    return "\n[CONTEXT: user used 'crack/cracking' as slang — it means being extremely skilled, 'going off', or letting someone do their thing (like 'let him cook'). It does NOT mean breaking, drugs, or cracking jokes. Respond naturally to the slang.]";
  }

  // Detect "crack someone", "crack you", "crack him" -> teasing/roasting
  if (/\bcrack(?:ing)?\s+(?:someone|somebody|you|u|me|him|her|them|bro)\b/.test(lower) || /\bcrack\s+you\b/.test(lower)) {
    return "\n[CONTEXT: user used 'crack someone' as slang — it means to mess with them, tease them, roast them, or try to get a reaction out of them. Respond naturally knowing this definition.]";
  }
  
  return null;
}
