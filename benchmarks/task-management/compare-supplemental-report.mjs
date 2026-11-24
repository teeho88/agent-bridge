import {writeFileSync,existsSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSupplementalMeasurements,applySupplementalMeasurements} from './supplemental-measurements.mjs';

const [manifest,output]=process.argv.slice(2);
if(!manifest||!output)throw Error('Usage: compare-supplemental-report.mjs supplement.json output.json');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),target=resolve(output);
const rel=relative(root,target);
if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Supplemental output outside project');
const parent=relative(realpathSync(root),realpathSync(dirname(target)));
if(parent.startsWith('..')||isAbsolute(parent))throw Error('Supplemental output parent outside project');
if(existsSync(target))throw Error('Supplemental output already exists');
const verified=loadSupplementalMeasurements(resolve(manifest),root);
const report=applySupplementalMeasurements(verified);
writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:target,missingUsageInvocations:report.experimentAccounting.missingUsageInvocations.length,
  independentWallPairs:report.groups.independent.ratios.wallMs.observed,thresholds:report.thresholds,
  measurementComplete:report.measurementComplete,releasePassed:report.releasePassed}));
