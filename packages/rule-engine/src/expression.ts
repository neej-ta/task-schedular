import type { Row } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// A tiny, SAFE expression evaluator (no eval / Function). Supports field refs,
// number/string/boolean/null literals, ! && || comparisons (== != < <= > >=),
// + - * /, and parentheses. Used by the `expression` rule and `computed`
// transform. Deterministic — same expr + same row ⇒ same result.
// ─────────────────────────────────────────────────────────────────────────────

type Tok = { t: string; v?: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const two = ['==', '!=', '<=', '>=', '&&', '||'];
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    const pair = src.slice(i, i + 2);
    if (two.includes(pair)) {
      toks.push({ t: pair });
      i += 2;
      continue;
    }
    if ('()+-*/<>!'.includes(c)) {
      toks.push({ t: c });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        s += src[j];
        j++;
      }
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      toks.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character '${c}' in expression`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

// Recursive-descent parser → evaluator over a row.
class Parser {
  private pos = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly row: Row,
  ) {}

  private peek(): Tok {
    return this.toks[this.pos]!;
  }
  private next(): Tok {
    return this.toks[this.pos++]!;
  }
  private expect(t: string): void {
    if (this.next().t !== t) throw new Error(`expected '${t}'`);
  }

  parse(): unknown {
    const v = this.or();
    if (this.peek().t !== 'eof') throw new Error('trailing tokens in expression');
    return v;
  }

  private or(): unknown {
    let left = this.and();
    while (this.peek().t === '||') {
      this.next();
      const right = this.and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }
  private and(): unknown {
    let left = this.equality();
    while (this.peek().t === '&&') {
      this.next();
      const right = this.equality();
      left = truthy(left) && truthy(right);
    }
    return left;
  }
  private equality(): unknown {
    let left = this.comparison();
    while (this.peek().t === '==' || this.peek().t === '!=') {
      const op = this.next().t;
      const right = this.comparison();
      left = op === '==' ? looseEq(left, right) : !looseEq(left, right);
    }
    return left;
  }
  private comparison(): unknown {
    const left = this.additive();
    // Relational operators are non-associative: evaluate at most one, so a
    // boolean result is never fed back into a numeric comparison (`a < b < c`).
    const op = this.peek().t;
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      this.next();
      const right = this.additive();
      const a = Number(left);
      const b = Number(right);
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    }
    return left;
  }
  private additive(): unknown {
    let left = this.multiplicative();
    while (this.peek().t === '+' || this.peek().t === '-') {
      const op = this.next().t;
      const right = this.multiplicative();
      if (op === '+') {
        left =
          typeof left === 'string' || typeof right === 'string'
            ? String(left) + String(right)
            : Number(left) + Number(right);
      } else {
        left = Number(left) - Number(right);
      }
    }
    return left;
  }
  private multiplicative(): unknown {
    let left = this.unary();
    while (this.peek().t === '*' || this.peek().t === '/') {
      const op = this.next().t;
      const right = this.unary();
      left = op === '*' ? Number(left) * Number(right) : Number(left) / Number(right);
    }
    return left;
  }
  private unary(): unknown {
    if (this.peek().t === '!') {
      this.next();
      return !truthy(this.unary());
    }
    if (this.peek().t === '-') {
      this.next();
      return -Number(this.unary());
    }
    return this.primary();
  }
  private primary(): unknown {
    const tok = this.next();
    switch (tok.t) {
      case '(': {
        const v = this.or();
        this.expect(')');
        return v;
      }
      case 'num':
        return Number(tok.v);
      case 'str':
        return tok.v;
      case 'ident':
        if (tok.v === 'true') return true;
        if (tok.v === 'false') return false;
        if (tok.v === 'null') return null;
        return this.row[tok.v!];
      default:
        throw new Error(`unexpected token '${tok.t}'`);
    }
  }
}

function truthy(v: unknown): boolean {
  return !!v;
}
function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

export function evalExpression(expr: string, row: Row): unknown {
  return new Parser(tokenize(expr), row).parse();
}
