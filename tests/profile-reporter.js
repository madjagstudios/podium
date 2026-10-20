import fs from 'node:fs';
import path from 'node:path';
import { profileEnabled, profileWarning } from './profile-metrics.js';

export default async function* reporter(source) {
  const rows = [];
  for await (const { type, data } of source) {
    if (profileEnabled && (type === 'test:pass' || type === 'test:fail')) {
      rows.push(JSON.stringify({ kind: 'test', result: type, file: data.file, name: data.name, ms: data.details?.duration_ms, skip: data.skip }) + '\n');
    }
  }
  try { if (rows.length) fs.writeFileSync(path.join(process.env.PODIUM_TEST_PROFILE_DIR, 'tests.ndjson'), rows.join('')); }
  catch (error) { profileWarning(error); }
}
