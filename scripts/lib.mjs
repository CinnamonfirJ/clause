import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const isWin = process.platform === 'win32';

/**
 * Well-known Hardhat default accounts. PUBLIC TEST KEYS — every Hardhat install ships them.
 * Local development only. Never fund these on a real network.
 */
export const HARDHAT_KEYS = {
  gateway: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // #2
  seller: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // #3
  funder: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // #5
};

export function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) }, shell: isWin, stdio: opts.stdio ?? 'inherit' });
  return child;
}

export function runToEnd(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const c = run(cmd, args, opts);
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

export function waitForOutput(child, pattern, timeoutMs = 60_000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out waiting for ${pattern}`)), timeoutMs);
    const on = (d) => {
      if (pattern.test(String(d))) {
        clearTimeout(t);
        res();
      }
    };
    child.stdout?.on('data', on);
    child.stderr?.on('data', on);
    child.on('exit', (code) => rej(new Error(`process exited (${code}) before ready`)));
  });
}

export function startHardhatNode(port) {
  const node = run('npx', ['hardhat', 'node', '--port', String(port)], { cwd: join(ROOT, 'packages/contracts'), stdio: ['ignore', 'pipe', 'pipe'] });
  return node;
}

export function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
