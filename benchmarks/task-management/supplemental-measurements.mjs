import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {distribution} from './comparison.mjs';

const read=file=>JSON.parse(readFileSync(file,'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(JSON.stringify(value));
const sha=file=>hash(readFileSync(file));
const sourceDirectory=dirname(fileURLToPath(import.meta.url));
export function loadSupplementalMeasurements(file,root) {
  const contained=path=>{
    const target=realpathSync(resolve(path)),rel=relative(realpathSync(root),target);
    assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Supplemental path outside project');
    return target;
  };
  const verify=reference=>{
    assert.match(reference.sha256,/^[a-f0-9]{64}$/);
    const path=contained(reference.path);
    assert.equal(sha(path),reference.sha256,'Supplemental evidence hash mismatch: '+path);
    return path;
  };
  const supplement=read(contained(file));
  assert.equal(supplement.kind,'G7-accounting-and-wall-supplement-v1');
  assert.ok(supplement.userInstruction?.trim());
  assert.equal(supplement.modelCallsAdded,0);
  assert.equal(supplement.historicalVerdictChangesAllowed,false);
  assert.equal(supplement.implementationTimeRecoveryAllowed,false);
  assert.deepEqual(Object.keys(supplement.sources).sort(),['compare-supplemental-report.mjs','comparison.mjs','supplemental-measurements.mjs']);
  for(const [name,ref] of Object.entries(supplement.sources)){
    assert.equal(realpathSync(verify(ref)),realpathSync(resolve(sourceDirectory,name)));
    assert.equal(supplement.sourceArchives[name].sha256,ref.sha256);
    verify(supplement.sourceArchives[name]);
  }
  for(const reference of Object.values(supplement.inputs))verify(reference);
  for(const reference of supplement.effectiveSources)verify(reference);
  const state=read(supplement.inputs.state.path),ledger=read(supplement.inputs.ledger.path);
  const audit=read(supplement.inputs.audit.path),finalized=read(supplement.inputs.finalizedReview.path);
  const base=read(supplement.inputs.baseReport.path),protocol=read(supplement.inputs.protocol.path);
  const handoff=read(supplement.inputs.handoff.path);
  assert.equal(supplement.inputs.baseReport.sha256,handoff.report.sha256);
  assert.equal(supplement.inputs.parentAuthorization.sha256,handoff.authorization.sha256);
  assert.deepEqual(supplement.effectiveSources,handoff.effectiveSources);
  const {protocolHash,...body}=protocol;
  assert.equal(digest(body),protocolHash);
  for(const value of [supplement,state,ledger,audit,finalized,base])assert.equal(value.protocolHash,protocolHash);
  assert.equal(state.status,'formal-completed');
  assert.equal(audit.mechanicalIntegrityPassed,true); assert.equal(audit.partial,false);
  assert.equal(finalized.verdict,'pass'); assert.deepEqual(finalized.rows,ledger.rows);
  assert.equal(finalized.reviewLedgerHash,supplement.inputs.ledger.sha256);
  assert.equal(finalized.auditHash,supplement.inputs.audit.sha256);
  assert.equal(base.finalizedReviewPassed,true); assert.equal(base.qualityPassed,true);
  assert.equal(base.measurementComplete,false); assert.equal(base.releasePassed,false);
  for(const [key,name] of Object.entries({stateHash:'state',auditHash:'audit',reviewHash:'ledger',finalizedReviewHash:'finalizedReview'}))
    assert.equal(base.provenance[key],supplement.inputs[name].sha256);
  assert.equal(base.supplementalMeasurements,undefined);
  assert.equal(supplement.inputs.parentAuthorization.sha256,supplement.parentAuthorizationHash);
  const phaseRows=state.slots.filter(x=>x.phase==='formal');
  assert.equal(finalized.phaseStateHash,digest(phaseRows)); assert.equal(audit.phaseStateHash,finalized.phaseStateHash);
  assert.deepEqual(supplement.accounting.map(x=>x.id),['B-4-handoff-2']);
  const recovery=supplement.accounting[0],row=state.slots.find(x=>x.id===recovery.id);
  const review=ledger.rows.find(x=>x.id===recovery.id);
  assert.equal(recovery.scope,'experiment-accounting-only');
  assert.equal(row.turn?.status,'completed'); assert.equal(review.verdict,'blocked');
  assert.equal(digest(row),recovery.rowHash); assert.equal(digest(review),recovery.reviewHash);
  assert.ok(base.experimentAccounting.missingUsageInvocations.includes(row.id));
  assert.equal(recovery.attemptId,row.attemptId);
  for(const ref of Object.values(recovery.evidence))verify(ref);
  assert.equal(realpathSync(recovery.evidence.raw.path),realpathSync(row.rawProtocol));
  assert.equal(recovery.evidence.raw.sha256,row.rawProtocolHash);
  assert.equal(recovery.evidence.events.sha256,review.assessment.eventsHash);
  const parse=file=>readFileSync(file,'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const raw=parse(recovery.evidence.raw.path),events=parse(recovery.evidence.events.path).map(x=>x.message);
  const select=list=>list.filter(x=>['thread/tokenUsage/updated','turn/completed'].includes(x.method));
  assert.deepEqual(select(raw),select(events));
  for(const item of select(raw)){
    assert.equal(item.params.threadId,row.launch.threadId);
    assert.equal(item.method==='turn/completed'?item.params.turn.id:item.params.turnId,row.launch.turnId);
  }
  const last=raw.findLast(x=>x.method==='thread/tokenUsage/updated');
  const terminal=raw.filter(x=>x.method==='turn/completed');
  assert.equal(terminal.length,1); assert.equal(terminal[0].params.turn.status,'completed');
  assert.deepEqual(terminal[0].params.turn,row.turn);
  const finalAnswer=raw.findLastIndex(x=>x.method==='item/completed'&&x.params.item?.type==='agentMessage'&&x.params.item.phase==='final_answer');
  assert.ok(finalAnswer>=0);
  assert.ok(raw.indexOf(last)>finalAnswer&&raw.indexOf(last)<raw.indexOf(terminal[0]));
  const usage=last.params.tokenUsage.total;
  for(const key of ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens']){
    assert.ok(Number.isSafeInteger(usage[key])&&usage[key]>=0);
    assert.equal(row.usage[key],usage[key]); assert.equal(recovery.usage[key],usage[key]);
  }
  assert.ok(usage.cachedInputTokens<=usage.inputTokens);
  assert.equal(recovery.usage.uncachedInputTokens,usage.inputTokens-usage.cachedInputTokens);
  assert.equal(usage.totalTokens,usage.inputTokens+usage.outputTokens);
  assert.deepEqual(read(recovery.evidence.result.path).usage,row.usage);
  const stop=read(recovery.evidence.stop.path),cleanup=read(recovery.evidence.cleanup.path);
  assert.equal(stop.writersStopped,true); assert.equal(stop.activeProcesses,0); assert.equal(stop.appContainer,true);
  assert.equal(cleanup.passed,true); assert.equal(row.nativeStop.runId,row.launch.runId);
  assert.deepEqual(supplement.wall.map(x=>x.id),['S-5-small-1-attempt-2']);
  const wall=supplement.wall[0],target=state.slots.find(x=>x.id===wall.id);
  assert.equal(target.implementationMs,undefined); assert.equal(target.elapsedMs,undefined);
  assert.equal(target.hostFinalization.kind,'daemon-restart-terminal-reconciliation');
  assert.equal(target.turn,null);
  assert.equal(digest(target),wall.rowHash);
  const wallReview=ledger.rows.find(x=>x.id===target.id),predecessor=state.slots.find(x=>x.id===target.continuationFrom);
  const previousReview=ledger.rows.find(x=>x.id===predecessor?.id);
  assert.equal(digest(wallReview),wall.reviewHash); assert.equal(wallReview.verdict,'blocked');
  const endToEndMs=Date.parse(wallReview.reviewedAt)-Date.parse(target.startedAt);
  const gap=Date.parse(target.startedAt)-Date.parse(previousReview.reviewedAt);
  assert.ok(Number.isFinite(endToEndMs)&&endToEndMs>=0&&Number.isFinite(gap)&&gap>=0);
  assert.equal(wallReview.endToEndMs,endToEndMs);
  assert.equal(wall.wallMs,endToEndMs+gap);
  for(const ref of Object.values(wall.evidence))verify(ref);
  const preconditions=read(wall.evidence.preconditions.path);
  assert.equal(preconditions.finalTurnPresent,false);
  assert.equal(wall.evidence.raw.sha256,target.rawProtocolHash);
  assert.equal(preconditions.rawHash,wall.evidence.raw.sha256);
  assert.equal(preconditions.eventsHash,wall.evidence.events.sha256);
  assert.equal(preconditions.nativeStopHash,wall.evidence.stop.sha256);
  assert.equal(parse(wall.evidence.raw.path).some(x=>x.method==='turn/completed'),false);
  const interruptedStop=read(wall.evidence.stop.path);
  assert.equal(interruptedStop.writersStopped,true); assert.equal(interruptedStop.activeProcesses,0);
  assert.equal(read(wall.evidence.cleanup.path).passed,true);
  const original=read(wall.evidence.stateBefore.path).slots.find(x=>x.id===target.id);
  assert.equal(original.implementationMs,undefined); assert.equal(original.elapsedMs,undefined);
  const pairRows=phaseRows.filter(x=>x.repetition===5&&x.taskId==='small');
  assert.deepEqual(pairRows.map(x=>x.id),wall.pairAttemptIds);
  const totals={B:0,S:0};
  for(const attempt of pairRows){
    const reviewed=ledger.rows.find(x=>x.id===attempt.id);
    const duration=Date.parse(reviewed.reviewedAt)-Date.parse(attempt.startedAt);
    assert.equal(duration,reviewed.endToEndMs);
    const prior=ledger.rows.find(x=>x.id===attempt.continuationFrom);
    const wait=prior?Date.parse(attempt.startedAt)-Date.parse(prior.reviewedAt):0;
    assert.ok(duration>=0&&Number.isFinite(wait)&&wait>=0);
    totals[attempt.branch]+=duration+wait;
  }
  assert.deepEqual(totals,wall.pairTotals);
  const pair=base.pairs.find(x=>x.repetition===5&&x.taskId==='small');
  assert.equal(pair.B.wallMs,totals.B); assert.equal(pair.S.wallMs,null);
  assert.equal(pair.S.implementationMs,null);
  return {supplement,base,usage:structuredClone(recovery.usage),wallTotals:totals,authorizationHash:sha(file)};
}

export function applySupplementalMeasurements(verified){
  const {base,supplement,usage,wallTotals,authorizationHash}=verified;
  const report=structuredClone(base),id=supplement.accounting[0].id;
  assert.ok(report.experimentAccounting.missingUsageInvocations.includes(id));
  report.createdAt=new Date().toISOString();
  report.provenance.supplementalAuthorizationHash=authorizationHash;
  report.provenance.baseReportHash=supplement.inputs.baseReport.sha256;
  report.provenance.supplementalReporterHash=supplement.sources['compare-supplemental-report.mjs'].sha256;
  report.provenance.supplementalValidatorHash=supplement.sources['supplemental-measurements.mjs'].sha256;
  report.experimentAccounting.missingUsageInvocations=report.experimentAccounting.missingUsageInvocations.filter(x=>x!==id);
  report.experimentAccounting.partialUsage=report.experimentAccounting.partialUsage.filter(x=>x.id!==id);
  report.experimentAccounting.supplementalFinalUsage=[{id,usage,scope:'experiment-accounting-only',authorizationHash}];
  const retained=report.formalDisconnectRecoveries?.find(x=>x.retainedFailure===id);
  if(retained)Object.assign(retained,{finalUsage:usage,accountingComplete:true,supplementalAuthorizationHash:authorizationHash});
  const pair=report.pairs.find(x=>x.repetition===5&&x.taskId==='small');
  pair.S.wallMs=wallTotals.S; pair.ratios.wallMs=wallTotals.S/wallTotals.B;
  const independent=report.pairs.filter(x=>x.taskId!=='handoff'),group=report.groups.independent;
  group.ratios.wallMs=distribution(independent.map(x=>x.ratios.wallMs));
  for(const branch of ['B','S']){
    const values=independent.map(x=>x[branch].wallMs);
    group.distributions[branch].wallMs=distribution(values);
    group.totals[branch].wallMs=values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0):null;
  }
  group.regressions=group.regressions.filter(x=>!(x.repetition===5&&x.taskId==='small'&&x.metric==='wallMs'));
  if(pair.ratios.wallMs>1)group.regressions.push({repetition:5,taskId:'small',metric:'wallMs',ratio:pair.ratios.wallMs});
  report.thresholds.independentWallTime=group.ratios.wallMs.median===null?null:group.ratios.wallMs.median<=1.10;
  report.supplementalMeasurements={authorizationHash,baseReport:supplement.inputs.baseReport,
    usageScope:'experiment-accounting-only; paired token metrics unchanged',recoveredUsageInvocations:[id],
    recoveredWallAttempts:supplement.wall.map(x=>x.id),unrecoveredImplementationAttempts:supplement.wall.map(x=>x.id),
    originalMissingUsageInvocations:base.experimentAccounting.missingUsageInvocations,modelCallsAdded:0};
  report.measurementComplete=false; report.releasePassed=false;
  report.measurementConclusion='quality-passed-measurement-incomplete';
  return report;
}
