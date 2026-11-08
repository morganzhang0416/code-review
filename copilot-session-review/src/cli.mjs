import path from 'node:path';
import { loadConfig } from './config.mjs';
import { runReview } from './run.mjs';

const args = process.argv.slice(2);
let hours;
let outDir;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--hours') {
    hours = Number(args[++index]);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31) {
      throw new Error('--hours must be a number between 1 and 744');
    }
  } else if (arg === '--out') {
    const value = args[++index];
    if (!value) throw new Error('--out needs a directory');
    outDir = path.resolve(value);
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

const result = await runReview({
  config: loadConfig(),
  hours,
  outDir,
  notify: false,
});
if (result.status !== 'ok') {
  console.log(`Skipped: ${result.reason}`);
} else {
  console.log(`Report: ${result.report}`);
  console.log(`Digest: ${result.digest}`);
  console.log(`${result.totals.entries} sessions, ${result.totals.prompts} prompts, ${result.good} positive signals, ${result.improve} suggestions`);
}
