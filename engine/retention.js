import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { listJobDirs, readJob, appendLog } from './store.js';
import { loadSettings } from './settings.js';

const DAY = 86_400_000;
const HEAVY = ['output.md', 'output.md.gz', 'stderr.log', 'diff.patch', 'live.json'];
const SKIP = new Set(['queued', 'running', 'needs-review']);

export function readOutput(dir) {
  const plain = path.join(dir, 'output.md');
  if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8');
  if (fs.existsSync(`${plain}.gz`)) return zlib.gunzipSync(fs.readFileSync(`${plain}.gz`)).toString('utf8');
  return null;
}

export function prune(root, { now = Date.now() } = {}) {
  const settings = loadSettings(root);
  const result = { compressed: 0, deleted: 0 };
  for (const dir of listJobDirs(root)) {
    const job = readJob(dir);
    if (!job.endedAt || SKIP.has(job.status)) continue;
    if (settings.pinned.includes(`${job.project}/${job.ticket}`)) continue;
    const ageDays = (now - Date.parse(job.endedAt)) / DAY;
    if (ageDays >= settings.retention.deleteDays) {
      const present = HEAVY.map((f) => path.join(dir, f)).filter((p) => fs.existsSync(p));
      if (present.length) {
        present.forEach((p) => fs.rmSync(p));
        result.deleted++;
        appendLog(root, job.project, { jobId: job.id, event: 'pruned' });
      }
    } else if (ageDays >= settings.retention.compressDays) {
      const plain = path.join(dir, 'output.md');
      if (fs.existsSync(plain)) {
        fs.writeFileSync(`${plain}.gz`, zlib.gzipSync(fs.readFileSync(plain)));
        fs.rmSync(plain);
        result.compressed++;
      }
    }
  }
  return result;
}
