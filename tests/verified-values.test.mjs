import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const logic=app.slice(app.indexOf('function validVerifiedValue'),app.indexOf('function detailMetricRows'));

test('a sourced claim fills a missing field without replacing a live value',()=>{
  const spec={id:'claims',label:'Initial Jobless Claims',primary:true};
  const entry={date:'2026-09-24',filter_id:'claims',metric_id:'claims',field:'forecast',value:'201.00K',source_url:'https://example.org/consensus',verified_at:'2026-09-23T22:00:00Z'};
  const scope={state:{verifiedValues:[entry],allEvents:[]},METRIC_SPECS:{claims:[spec]},FILTER_DEFS:[{id:'claims'}],
    feedNumber:v=>/^\d+(?:\.\d+)?K$/.test(v)?v:null,
    findComponent:()=>null,latestPriorOccurrence:()=>null,parseEventDate:()=>new Date('2026-09-24T12:30:00Z'),
    extractSummaryValue:()=>null,actualForSpec:()=>null,surpriseValue:()=> '—'};
  const evaluate=vm.runInNewContext(`${logic}\n({validVerifiedValue,buildMetricRows})`,scope);
  assert.equal(evaluate.validVerifiedValue(entry),true);
  assert.equal(evaluate.validVerifiedValue({...entry,value:'unverified'}),false);
  const missing=evaluate.buildMetricRows({date:'2026-09-24',filterId:'claims',components:[]});
  assert.equal(missing[0].forecast,'201.00K');
  assert.equal(missing[0].verifiedSources[0].source_url,entry.source_url);
  const live=evaluate.buildMetricRows({date:'2026-09-24',filterId:'claims',components:[],forecast:'202K'});
  assert.equal(live[0].forecast,'202K');
});
