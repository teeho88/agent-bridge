import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeReceiptRecovery } from '../benchmarks/task-management/receipt-recovery.mjs';
const [pointer, ...reason] = process.argv.slice(2);
if (!pointer || !reason.length) throw Error('Usage: phase8-receipt-recovery.mjs <pointer> <user instruction>');
const auth = await authorizeReceiptRecovery(resolve(pointer), reason.join(' '), fileURLToPath(new URL('..', import.meta.url)));
console.log(JSON.stringify({ targetId: auth.targetId, authorizationHash: auth.authorizationHash }));
