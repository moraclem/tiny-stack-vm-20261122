// Tiny stack VM (ISA v1): each /input/<id>/program.bin + input.bin
// becomes /output/<id>/stdout.bin + exit.txt.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Trap codes: underflow 2, overflow 3, div-by-zero 4, bad opcode 5,
// bad memory 6, call depth 7, empty ret 8, bad pc 9, steps 10, output 11.
const T_UNDER = 2, T_OVER = 3, T_DIV0 = 4, T_OP = 5, T_MEM = 6, T_CALL = 7, T_RET = 8, T_PC = 9, T_STEP = 10, T_OUT = 11;

// Runs one program on its input bytes; returns the bytes it wrote and the exit code.
function runProgram(prog: Uint8Array, input: Uint8Array) {
  const data: number[] = [];
  const calls: number[] = [];
  const mem = new Int32Array(256);
  const out = new Uint8Array(65536);
  const enc = new TextEncoder();
  let olen = 0, inPos = 0, pc = 0, steps = 0;

  const done = (code: number) => ({ bytes: out.slice(0, olen), code });
  const trap = (c: number): never => { throw c; };
  const push = (v: number) => { if (data.length >= 256) trap(T_OVER); data.push(v); };
  const pop = (): number => { if (data.length === 0) trap(T_UNDER); return data.pop()!; };
  const bin = (f: (a: number, b: number) => number) => { const b = pop(); const a = pop(); push(f(a, b)); };

  try {
    for (;;) {
      if (steps >= 1e6) trap(T_STEP);
      if (pc < 0 || pc >= prog.length) trap(T_PC);
      const op = prog[pc];
      // Immediate bytes: PUSH8 1, PUSH32 4, JMP/JZ/JNZ/CALL 2, else 0.
      const imm = op === 1 ? 1 : op === 2 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0;
      const after = pc + 1 + imm;
      if (after > prog.length) trap(T_PC);
      steps++;
      pc = after;

      switch (op) {
        case 0x00: return done(0); // HALT
        case 0x01: push((prog[after - 1] << 24) >> 24); break; // PUSH8, sign-extended
        case 0x02: push(prog[after - 4] | (prog[after - 3] << 8) | (prog[after - 2] << 16) | (prog[after - 1] << 24)); break; // PUSH32
        case 0x03: pop(); break; // POP
        case 0x04: { const a = pop(); push(a); push(a); break; } // DUP
        case 0x05: { const b = pop(); const a = pop(); push(b); push(a); break; } // SWAP
        case 0x06: { const b = pop(); const a = pop(); push(a); push(b); push(a); break; } // OVER
        case 0x07: { const c = pop(); const b = pop(); const a = pop(); push(b); push(c); push(a); break; } // ROT
        case 0x17: push((-pop()) | 0); break; // NEG
        case 0x1b: push(~pop()); break; // NOT
        case 0x10: bin((a, b) => (a + b) | 0); break; // ADD
        case 0x11: bin((a, b) => (a - b) | 0); break; // SUB
        case 0x12: bin(Math.imul); break; // MUL, low 32 bits
        case 0x18: bin((a, b) => a & b); break; // AND
        case 0x19: bin((a, b) => a | b); break; // OR
        case 0x1a: bin((a, b) => a ^ b); break; // XOR
        case 0x1c: bin((a, b) => a << (b & 31)); break; // SHL
        case 0x1d: bin((a, b) => a >> (b & 31)); break; // SHR, arithmetic
        case 0x1e: bin((a, b) => (a >>> (b & 31)) | 0); break; // SHRU, logical
        case 0x20: bin((a, b) => (a === b ? 1 : 0)); break; // EQ
        case 0x21: bin((a, b) => (a < b ? 1 : 0)); break; // LT, signed
        case 0x22: bin((a, b) => (a >>> 0 < (b >>> 0) ? 1 : 0)); break; // LTU, unsigned
        case 0x13: case 0x14: case 0x15: case 0x16: { // DIV / MOD / DIVU / MODU
          const b = pop(); const a = pop();
          if (b === 0) trap(T_DIV0);
          if (op === 0x13) push(a === -2147483648 && b === -1 ? a : (a / b) | 0);
          else if (op === 0x14) push(b === -1 ? 0 : (a % b) | 0);
          else if (op === 0x15) push(Math.floor((a >>> 0) / (b >>> 0)) | 0);
          else push(((a >>> 0) % (b >>> 0)) | 0);
          break;
        }
        case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
          const rel = ((prog[after - 2] | (prog[after - 1] << 8)) << 16) >> 16;
          let take = op === 0x30;
          if (op !== 0x30) { const v = pop(); take = op === 0x31 ? v === 0 : v !== 0; }
          if (take) pc = after + rel;
          break;
        }
        case 0x33: // CALL
          if (calls.length >= 64) trap(T_CALL);
          calls.push(after);
          pc = prog[after - 2] | (prog[after - 1] << 8);
          break;
        case 0x34: // RET
          if (calls.length === 0) trap(T_RET);
          pc = calls.pop()!;
          break;
        case 0x40: { // LOAD
          const addr = pop();
          if (addr < 0 || addr >= 256) trap(T_MEM);
          push(mem[addr]);
          break;
        }
        case 0x41: { // STORE: (value addr --)
          const addr = pop(); const value = pop();
          if (addr < 0 || addr >= 256) trap(T_MEM);
          mem[addr] = value;
          break;
        }
        case 0x50: { // PRINT, decimal ASCII, no newline
          const bytes = enc.encode(String(pop()));
          if (olen + bytes.length > 65536) trap(T_OUT);
          out.set(bytes, olen);
          olen += bytes.length;
          break;
        }
        case 0x51: { // PUTC, one byte
          const v = pop();
          if (olen + 1 > 65536) trap(T_OUT);
          out[olen++] = v & 255;
          break;
        }
        case 0x52: push(inPos < input.length ? input[inPos++] : -1); break; // IN, -1 once used up
        case 0x53: return done(pop() & 255); // EXIT, low byte
        default: trap(T_OP); // unknown opcode
      }
    }
  } catch (e) {
    return done(e as number);
  }
}

function main(): void {
  const inputRoot = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputRoot = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const ids = readdirSync(inputRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const id of ids) {
    const dir = join(inputRoot, id);
    const prog = readFileSync(join(dir, "program.bin"));
    const inputPath = join(dir, "input.bin");
    const input = existsSync(inputPath) ? readFileSync(inputPath) : Buffer.alloc(0);
    const outcome = runProgram(new Uint8Array(prog), new Uint8Array(input));
    const outDir = join(outputRoot, id);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "stdout.bin"), outcome.bytes);
    writeFileSync(join(outDir, "exit.txt"), `${outcome.code}\n`);
  }
}

main();
