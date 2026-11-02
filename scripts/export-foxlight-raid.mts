import {writeFileSync} from 'node:fs';
import {foxlightRaid} from '../fixtures/foxlight.js';

// Writes the exact raid RecapPlan and published snapshot of the Foxlight example (logical ids) as JSON.
// Usage: npx tsx scripts/export-foxlight-raid.mts <output.json>   (prints to stdout without a path)
const output = process.argv[2], json = JSON.stringify(foxlightRaid(), null, 2);
if (output) {writeFileSync(output, json + '\n'); console.log(`Wrote the Foxlight raid plan and snapshot to ${output}.`);}
else process.stdout.write(json + '\n');
