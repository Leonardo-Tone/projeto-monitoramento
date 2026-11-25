import { uptime } from 'node:os';

export function processOwnerAlive(pid, recordedAtMs, {
  platform = process.platform,
  bootTimeMs = Date.now() - uptime() * 1000,
  probe = process.kill,
} = {}) {
  // Windows can reuse a PID after reboot or deny a probe of its new owner.
  // Leave a margin for clock precision near startup.
  if (platform === 'win32' && recordedAtMs > 0 && recordedAtMs < bootTimeMs - 5000) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
