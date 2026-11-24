import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const out=resolve('docs/phase8-recovery-20261019/validated');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const pointerPath=resolve('docs/phase8-2-20261018/round.json'),pointer=read(pointerPath),statePath=join(pointer.directory,'state.json'),state=read(statePath);
assert.equal(state.status,'quality_failed');assert.equal(state.slots.length,2);assert.equal(state.slots.filter(r=>r.phase==='formal').length,0);
const ledgerPath=join(pointer.directory,'smoke-content-review.json'),ledger=read(ledgerPath),terminalReview=read(join(pointer.directory,'smoke-review.json'));
assert.deepEqual(ledger.rows.map(r=>r.verdict),['rework','blocked']);assert.equal(terminalReview.verdict,'blocked');assert.equal(terminalReview.reviewLedgerHash,sha(ledgerPath));
const final=read(join(out,'source-final.json')),freeze=read(join(out,'freeze-checkpoint.json'));
assert.deepEqual(final.sources,freeze.sources);
const before=read(join(out,'source-before.json')),packageDrift=[];
for(const [p,h]of Object.entries(final.sources))if(p.startsWith('packages/')&&before.packages[p.slice('packages/'.length)]!==h)packageDrift.push(p);
assert.deepEqual(packageDrift,[]);
const rows=[];
for(const row of state.slots){
 assert.equal(row.status,'finished');assert.equal(row.nativeStop.runId,row.launch.runId);assert.equal(row.nativeStop.writersStopped,true);assert.equal(row.nativeStop.activeProcesses,0);
 assert.equal(sha(row.rawProtocol),row.rawProtocolHash);
 const database=join(row.evidence,'agent-memory/memories.db'),db=new DatabaseSync(database,{readOnly:true});let activeLeases;
 try{activeLeases=db.prepare('SELECT count(*) AS n FROM file_leases WHERE released_at IS NULL').get().n;}finally{db.close();}
 assert.equal(activeLeases,0);assert.ok(!read(join(row.workspace,'.agent-memory/config.json')).currentSessions?.codex);
 const reviewed=ledger.rows.find(r=>r.id===row.id);assert.equal(reviewed.sourceManifestHash,sha(join(row.evidence,'source-after.json')));assert.equal(reviewed.resultHash,sha(join(row.evidence,'RESULT.md')));
 rows.push({id:row.id,attempt:row.attempt,acceptance:row.acceptance,turnStatus:row.turn.status,usage:row.usage,totalTokens:row.usage.inputTokens+row.usage.outputTokens,weightedTokens:row.usage.uncachedInputTokens+row.usage.outputTokens*8,elapsedMs:row.elapsedMs,reviewVerdict:reviewed.verdict,activeReviewMs:reviewed.activeReviewMs,endToEndMs:reviewed.endToEndMs,rawProtocolHash:row.rawProtocolHash,nativeStop:row.nativeStop,activeLeases,sessionClosed:true,sourceBeforeHash:sha(join(row.evidence,'source-before.json')),sourceAfterHash:sha(join(row.evidence,'source-after.json'))});
}
const report=read(join(out,'comparison-report.json'));assert.equal(report.releasePassed,false);assert.equal(report.experimentAccounting.providerInvocations,2);
const previous=state.slots[0],continuation=state.slots[1];
assert.equal(sha(join(previous.evidence,'source-after.json')),sha(join(continuation.evidence,'source-before.json')));
const reportData={protocolHash:pointer.protocolHash,state:state.status,rows,experimentAccounting:report.experimentAccounting,formalSlots:0,smokeObservedLogicalSlots:1,smokeLatestPass:0,baselineMeasurementComplete:false,releasePassed:false,thresholds:report.thresholds,historicalEvidenceAvailable:false};
writeFileSync(join(out,'terminal-accounting.json'),JSON.stringify(reportData,null,2)+'\n',{flag:'wx'});
writeFileSync(join(out,'final-integrity.json'),JSON.stringify({observedAt:new Date().toISOString(),protocolHash:pointer.protocolHash,stateHash:sha(statePath),pointerHash:sha(pointerPath),reviewLedgerHash:sha(ledgerPath),terminalReviewHash:sha(join(pointer.directory,'smoke-review.json')),reportHash:sha(join(out,'comparison-report.json')),sourceFrozenUnchanged:true,candidatePackageSourceDrift:packageDrift,reviewedAttempts:rows.length,rawBindingsPassed:true,lifecycleClosed:true,continuationSourceMatched:true,historicalEvidenceAvailable:false,limitations:'Original historical artifacts were missing before this run. No historical unchanged-file claim is possible.'},null,2)+'\n',{flag:'wx'});
assert.ok(existsSync(join(out,'baseline-source/packages/cli/src/commands/handoff.ts')));
console.log(JSON.stringify({status:state.status,attempts:rows.length,smokeLatestPass:0,formalSlots:0,releasePassed:false,sourceFrozenUnchanged:true}));
