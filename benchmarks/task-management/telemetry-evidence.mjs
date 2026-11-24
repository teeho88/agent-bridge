import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readInvocationTelemetry} from './invocation-telemetry.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>hash(JSON.stringify(value));
export function verifyTelemetryEvidence(row,protocolHash,{requireFinalUsage=false}={}){
  const file=join(row.evidence,'invocation-telemetry.jsonl');
  assert.equal(resolve(row.telemetry?.path??''),resolve(file),'Telemetry path mismatch');
  const stat=lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'Telemetry must be a regular unlinked file');
  const binding={protocolHash,slotId:row.slotId??row.id,attemptId:row.attemptId,runId:row.launch?.runId,threadId:row.launch?.threadId,turnId:row.launch?.turnId};
  for(const value of Object.values(binding))assert.ok(typeof value==='string'&&value,'Incomplete telemetry binding');
  const summary=readInvocationTelemetry(file,binding);
  assert.equal(summary.truncatedTail,false,'Incomplete telemetry record');
  assert.equal(summary.captureErrors,0,'Telemetry capture error retained');
  const {path,...recorded}=row.telemetry;
  assert.deepEqual(recorded,summary,'Telemetry snapshot or head hash changed');
  const rawBytes=readFileSync(row.rawProtocol);
  assert.equal(hash(rawBytes),row.rawProtocolHash,'Telemetry raw protocol hash changed');
  const parse=bytes=>bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const messages=parse(rawBytes),events=parse(readFileSync(join(row.evidence,'events.jsonl'))).map(x=>x.message);
  const relevant=message=>message.method==='thread/tokenUsage/updated'||message.method==='turn/completed'||
    message.method==='item/completed'&&message.params?.item?.type==='agentMessage'&&message.params.item.phase==='final_answer';
  const raw=messages.filter(relevant),retained=events.filter(relevant);
  assert.deepEqual(raw,retained,'Telemetry raw/event sequence differs');
  const journal=parse(readFileSync(file));
  const hashes=journal.filter(x=>['usage','final-answer','terminal'].includes(x.type)).map(x=>x.data.providerEventHash);
  assert.deepEqual(hashes,raw.map(digest),'Telemetry provider event hash differs');
  const terminal=raw.findLast(x=>x.method==='turn/completed');
  assert.equal(summary.providerTurnStatus,row.turn?.status==='timeout'?null:row.turn?.status??null,'Telemetry terminal/status differs');
  if(terminal)assert.equal(terminal.params.turn.id,binding.turnId);
  assert.deepEqual(row.observedUsage??null,summary.observedUsage,'Observed telemetry usage differs');
  assert.deepEqual(row.usage??null,summary.finalUsage,'Final telemetry usage differs');
  assert.equal(row.implementationMs??null,summary.timing.implementationMs,'Telemetry implementation timing differs');
  assert.equal(row.elapsedMs??null,summary.timing.elapsedMs,'Telemetry elapsed timing differs');
  if(summary.timing.implementationMs!==null){
    assert.equal(row.nativeStop?.writersStopped,true);assert.equal(row.nativeStop?.activeProcesses,0);assert.equal(row.nativeStop?.appContainer,true);
  }
  const finalMeasurementPassed=summary.usageStatus==='confirmed-final'&&summary.timing.complete&&
    Number.isFinite(summary.timing.implementationMs)&&Number.isFinite(summary.timing.elapsedMs);
  if(requireFinalUsage)assert.equal(finalMeasurementPassed,true,'Telemetry final usage or complete timing missing');
  return {...summary,finalMeasurementPassed,journalHash:hash(readFileSync(file))};
}
