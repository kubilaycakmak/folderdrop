import { spawn } from 'node:child_process';

const [binary, ...args] = process.argv.slice(2);
const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
let timeout;
let stopped = false;

function stop() {
  if (stopped) return;
  stopped = true;
  child.kill();
  timeout = setTimeout(() => child.kill('SIGKILL'), 1600).unref();
}

process.on('message', message => { if (message === 'stop') stop(); });
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.once('error', () => { process.exitCode = 1; });
child.once('close', (code, signal) => {
  clearTimeout(timeout);
  process.exitCode = code ?? (signal && !stopped ? 1 : 0);
  if (process.connected) process.disconnect();
});
