// ─── Aho-Corasick multi-pattern literal matcher ────────────────────────────
// Phase 2.10: <1ms first-pass filter to skip the regex worker on the negative
// path. If NONE of the literal anchors appear in the input, no DANGEROUS_PATTERN
// can match either, so we can short-circuit.
//
// Built once at module load with case-insensitive matching by lowercasing both
// patterns at construction and the input at search time.

class AhoCorasick {
  constructor(patterns) {
    this._goto = [new Map()];
    this._fail = [0];
    this._out = [false]; // true if any pattern terminates at this node
    for (const p of patterns) this._add(p.toLowerCase());
    this._buildFailLinks();
  }

  _add(pattern) {
    let node = 0;
    for (const ch of pattern) {
      const next = this._goto[node].get(ch);
      if (next != null) {
        node = next;
      } else {
        const created = this._goto.length;
        this._goto.push(new Map());
        this._fail.push(0);
        this._out.push(false);
        this._goto[node].set(ch, created);
        node = created;
      }
    }
    this._out[node] = true;
  }

  _buildFailLinks() {
    const queue = [];
    for (const child of this._goto[0].values()) {
      this._fail[child] = 0;
      queue.push(child);
    }
    while (queue.length) {
      const r = queue.shift();
      for (const [ch, u] of this._goto[r]) {
        queue.push(u);
        let state = this._fail[r];
        while (state !== 0 && !this._goto[state].has(ch)) state = this._fail[state];
        this._fail[u] = this._goto[state].get(ch) ?? 0;
        if (this._fail[u] === u) this._fail[u] = 0;
        if (this._out[this._fail[u]]) this._out[u] = true;
      }
    }
  }

  /** Returns true on first match — short-circuit search. */
  hasMatch(text) {
    const lower = text.toLowerCase();
    let state = 0;
    for (let i = 0; i < lower.length; i++) {
      const ch = lower[i];
      while (state !== 0 && !this._goto[state].has(ch)) state = this._fail[state];
      state = this._goto[state].get(ch) ?? 0;
      if (this._out[state]) return true;
    }
    return false;
  }
}

export { AhoCorasick };
