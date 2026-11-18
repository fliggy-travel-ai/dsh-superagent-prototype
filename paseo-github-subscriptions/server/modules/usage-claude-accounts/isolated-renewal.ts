import { spawn } from 'node:child_process';
import { INITIALIZE_ARGS, renewalEnvironment } from './renewal.ts';

export function initializeIsolatedLogin(command: string, cwd: string, timeout: number): Promise<boolean> {
  return new Promise(resolve => {
    const environment = renewalEnvironment(process.env);
    delete environment.CLAUDE_CONFIG_DIR;
    const child = spawn(command, INITIALIZE_ARGS, {
      cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let accepted = false;
    let settled = false;
    let stopping = false;
    let buffer = '';
    let received = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupBudget = Math.min(300, Math.max(1, Math.floor(timeout / 4)));
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, value); else child.kill(value); }
      catch { try { child.kill(value); } catch {} }
    };
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(cleanupTimer);
      resolve(success);
    };
    const stop = () => {
      if (settled || stopping) return;
      stopping = true;
      child.stdin.end();
      try { child.kill('SIGTERM'); } catch {}
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), Math.max(1, cleanupBudget - 25));
      cleanupTimer = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(false);
      }, cleanupBudget);
    };
    const timer = setTimeout(stop, Math.max(1, timeout - cleanupBudget));
    child.once('error', () => finish(false));
    child.once('close', code => finish(!stopping && accepted && code === 0));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (settled || stopping) return;
      received += chunk.length;
      if (received > 65536) { stop(); return; }
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (['assistant', 'result', 'stream_event'].includes(message.type)) { stop(); return; }
          if (message.type !== 'control_response' || message.response?.request_id !== 'isolated-quota-renewal') continue;
          if (message.response.subtype !== 'success') { stop(); return; }
          accepted = true;
          child.stdin.end();
        } catch {}
      }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'isolated-quota-renewal', request: { subtype: 'initialize' } }) + '\n');
  });
}
