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
  assert.equal(classify('What is a good savings account interest rate in 2026?'),'');
  assert.equal(classify('Hilton Gets 15,000 Applications as AI Fuels Hiring Frenzy'),'');
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

test('next JOLTS release can show last month’s article once and prefer a publisher link',()=>{
  const now=Date.now(),old=now-20*86400000;
  const headline={title:'US job openings rise in July after revision',date_et:new Date(old).toISOString().slice(0,10),catalyst_tag:'Labor',major_catalyst:true};
  const scope={state:{marketHeadlines:[
    {...headline,url:'https://news.google.com/rss/articles/example',link_type:'google_news'},
    {...headline,url:'https://publisher.example/jolts',link_type:'publisher'}
  ]},parseEventDate:()=>new Date(now+86400000),normalize:s=>String(s).toLowerCase(),
  headlineTimestamp:()=>old,contextKeywordBonus:()=>3,impactLevelForHeadline:()=> 'medium',
  relevanceLevel:()=> 'high',whyForEventContext:()=> '',staticContextLinks:()=>[]};
  const select=vm.runInNewContext(`${appRules}\n${matchFunction}\nrelevantContextFor`,scope);
  const result=select({filterId:'jolts'}).headlines;
  assert.equal(result.length,1);
  assert.equal(result[0].url,'https://publisher.example/jolts');
});

test('report matches exclude foreign, regional, and speculative lookalikes',()=>{
  const matches=vm.runInNewContext(`${appRules}\nheadlineMatchesEvent`);
  assert.equal(matches('jolts','U.S. job openings rise in July'),true);
  assert.equal(matches('jolts','KC tech job openings jumped'),false);
  assert.equal(matches('cpi','China CPI inflation rebounds in August'),false);
  assert.equal(matches('cpi','US consumer prices accelerate in August'),true);
  assert.equal(matches('cpi','Consumer Price Index, New York-Newark-Jersey City'),false);
  assert.equal(matches('cpi','Consumer Price Index, Anchorage area — August 2026'),false);
  assert.equal(matches('confidence','Florida consumer sentiment falls'),false);
  assert.equal(matches('confidence','US consumer confidence falls, Conference Board says'),true);
  assert.equal(matches('gdp','US GDP growth scenario with humanoid robots'),false);
  assert.equal(matches('gdp','Anthropic Says Its Market Is $30 Trillion, Same As US GDP'),false);
  assert.equal(matches('durable','2 Funds to Boost Your Portfolio on Durable Goods Orders'),false);
  assert.equal(matches('pce','3 U.S. Retail Stocks Investors Are Watching As Consumer Spending Changes'),false);
  assert.equal(matches('gdp','Trump says U.S. GDP could grow 20%'),false);
});
