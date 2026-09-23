import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const updater=readFileSync(new URL('../scripts/update-data.mjs',import.meta.url),'utf8');
const appRules=app.slice(app.indexOf('const EVENT_CONTEXT_PROFILES'),app.indexOf('function contextKeywordBonus'));
const matchFunction=app.slice(app.indexOf('function relevantContextFor'),app.indexOf('function contextPublishedLabel'));
const classifyRules=updater.slice(updater.indexOf('const OIL_SUPPLY_RE'),updater.indexOf('const pad='));

test('category follows the article title, not the search that found it',()=>{
  const classify=vm.runInNewContext(`${classifyRules}\ncatalystTag`);
  assert.equal(classify('Global diesel shortage likely to last into 2027 as storage tanks drain'),'Oil / Supply');
  assert.equal(classify('JOLTS job openings fall as hiring slows'),'Labor');
  assert.equal(classify('Consumer confidence drops ahead of the Conference Board report'),'Consumer');
  assert.equal(classify('PMI data and crude oil inventories highlight Wednesday’s economic calendar'),'');
  assert.notEqual(classify('Fed rate hike jolts markets after new guidance'),'Labor');
  assert.notEqual(classify('Dollar General CEO comments on shoppers'),'Fed / Rates');
});

test('JOLTS context excludes generic GDP/PMI headlines and retains job-opening coverage',()=>{
  const now=Date.now();
  const observed=new Date(now-3600000).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const headlines=[
    {title:'PMI data and crude oil inventories highlight Wednesday’s economic calendar',url:'https://example.com/pmi',seendate:observed,catalyst_tag:'Growth / Demand',major_catalyst:true},
    {title:'KC tech job openings exploded in 2025',url:'https://example.com/kc',seendate:observed,catalyst_tag:'Labor',major_catalyst:true},
    {title:'Fed hike jolts gold ahead of oil retreat',url:'https://example.com/gold',seendate:observed,catalyst_tag:'Labor',major_catalyst:true},
    {title:'JOLTS job openings fall as hiring slows',url:'https://example.com/jolts',seendate:observed,catalyst_tag:'Labor',major_catalyst:true}
  ];
  const scope={state:{marketHeadlines:headlines},parseEventDate:()=>new Date(now+86400000),normalize:s=>s,
    headlineTimestamp:()=>now-3600000,contextKeywordBonus:(id,title)=>/JOLTS/.test(title)?3:0,
    impactLevelForHeadline:()=> 'medium',relevanceLevel:()=> 'high',whyForEventContext:()=> 'Job openings inform labor demand.',
    staticContextLinks:()=>[]};
  const select=vm.runInNewContext(`${appRules}\n${matchFunction}\nrelevantContextFor`,scope);
  const result=select({filterId:'jolts'}).headlines;
  assert.deepEqual(Array.from(result,h=>h.name),['JOLTS job openings fall as hiring slows']);
});
