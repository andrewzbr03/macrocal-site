import fs from 'node:fs/promises';

const API_BASE='https://www.financecalendar.com/wp-json/fc/v1';
const ARCHIVE_START='2026-09-23';
const RANGE_DAYS=14;
const BACK_DAYS=90;
const FUTURE_DAYS=180;
const US_COUNTRY_RE=/^(?:us|usa|u s|u\.s\.|united states|united states of america)$/i;
const FED_RE=/\b(?:fomc|federal reserve|fed chair|fed governor|fed president|federal funds)\b/i;
const US_TITLE_RE=/^(?:us|u\.s\.|united states)\b/i;
const GLOBAL_CONTEXT_RE=/\b(?:ecb|european central bank|bank of england|boe|bank of japan|boj|pboc|people'?s bank of china|bank of canada|boc|reserve bank of australia|rba|reserve bank of new zealand|rbnz|swiss national bank|snb|riksbank|norges bank|china.*(?:gdp|cpi|pmi)|euro(?:zone| area).*(?:gdp|cpi|pmi)|(?:central bank|interest )?rate decision|opec|crude oil|geopolit|government shutdown|debt ceiling)\b/i;
const TRUSTED_DOMAINS=['reuters.com','cnbc.com','bloomberg.com','wsj.com','ft.com','marketwatch.com','apnews.com','barrons.com','finance.yahoo.com'];
const MARKET_MOVE_RE=/(?:\b(?:stocks?|nasdaq|s&p|wall street|futures|treasury yields?|bond yields?|dollar)\b.{0,80}\b(?:rise|rises|rose|jump|jumps|jumped|surge|surges|surged|fall|falls|fell|drop|drops|dropped|slump|slumps|slumped|rally|rallies|rallied|slide|slides|slid|sink|sinks|sank|gain|gains|gained|selloff|sell-off)\b)|(?:\b(?:rise|rises|rose|jump|jumps|jumped|surge|surges|surged|fall|falls|fell|drop|drops|dropped|slump|slumps|slumped|rally|rallies|rallied|slide|slides|slid|sink|sinks|sank|gain|gains|gained|selloff|sell-off)\b.{0,80}\b(?:stocks?|nasdaq|s&p|wall street|futures|treasury yields?|bond yields?|dollar)\b)/i;

// Unscheduled macro/geopolitical catalysts that can matter for ES/NQ, rates, the dollar, or oil
// even when the headline does not literally say that markets moved.
const OIL_SUPPLY_RE=/\b(?:oil|crude|opec\+?|strait of hormuz|red sea|pipeline|refiner(?:y|ies)|tanker|shipping)\b.{0,90}\b(?:supply|disrupt|halt|cut|output|production|embargo|attack|strike|closure|closed|shutdown|shortage|risk)\b|\b(?:supply|disrupt|halt|cut|output|production|embargo|attack|strike|closure|closed|shutdown|shortage|risk)\b.{0,90}\b(?:oil|crude|opec\+?|strait of hormuz|red sea|pipeline|refiner(?:y|ies)|tanker|shipping)\b/i;
const GEOPOLITICAL_RE=/\b(?:iran|israel|middle east|gaza|lebanon|hezbollah|yemen|houthi|russia|ukraine|taiwan|china|north korea)\b.{0,110}\b(?:ceasefire|peace (?:deal|agreement|treaty)|talks? collapse|breaks? down|broken|attack|strike|missile|drone|war|escalat|invasion|retaliat|sanction|blockade|conflict)\b|\b(?:ceasefire|peace (?:deal|agreement|treaty)|talks? collapse|breaks? down|broken|attack|strike|missile|drone|war|escalat|invasion|retaliat|sanction|blockade|conflict)\b.{0,110}\b(?:iran|israel|middle east|gaza|lebanon|hezbollah|yemen|houthi|russia|ukraine|taiwan|china|north korea)\b/i;
const TRADE_POLICY_RE=/\b(?:tariff|trade war|export control|sanction|embargo|import ban|trade deal)\b/i;
const FISCAL_RISK_RE=/\b(?:government shutdown|debt ceiling|sovereign default|default risk|treasury funding crisis)\b/i;
const FINANCIAL_STRESS_RE=/\b(?:bank failure|bank run|bank stress|liquidity crisis|credit crisis|credit stress|regional bank|systemic risk)\b/i;
const MACRO_POLICY_RE=/\b(?:federal reserve|fed chair|jerome powell|fed governor|fed president|rate cut|rate hike|interest rates?|treasury yields?|bond yields?|inflation outlook|labor market|jobs growth|payrolls|unemployment|dollar)\b/i;
const TRUMP_POLICY_RE=/\btrump\b.{0,120}\b(?:truth social|post|tariff|trade|sanction|export control|federal reserve|fed|powell|interest rate|rate cut|rate hike|oil|iran|china|tax|budget|debt|dollar|treasury)\b|\b(?:truth social|tariff|trade|sanction|export control|federal reserve|fed|powell|interest rate|rate cut|rate hike|oil|iran|china|tax|budget|debt|dollar|treasury)\b.{0,120}\btrump\b/i;
function catalystTag(title=''){
  if(TRUMP_POLICY_RE.test(title))return 'Trump / Policy';
  if(OIL_SUPPLY_RE.test(title))return 'Oil / Supply';
  if(GEOPOLITICAL_RE.test(title))return 'Geopolitical';
  if(TRADE_POLICY_RE.test(title))return 'Trade / Sanctions';
  if(FISCAL_RISK_RE.test(title))return 'Fiscal risk';
  if(FINANCIAL_STRESS_RE.test(title))return 'Financial stress';
  if(MACRO_POLICY_RE.test(title))return 'Fed / Rates';
  return '';
}

const pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
const addDays=(d,n)=>new Date(d.getTime()+n*86400000);
const rawText=ev=>[ev.name,ev.title,ev.series,ev.category,ev.description].filter(Boolean).join(' ');
function isUS(ev){
  const country=String(ev.country||ev.country_name||ev.country_code||ev.iso_country||'').trim();
  if(country)return US_COUNTRY_RE.test(country);
  const currency=String(ev.currency||ev.ccy||'').trim().toUpperCase();
  if(currency)return currency==='USD';
  const t=rawText(ev);return US_TITLE_RE.test(t)||FED_RE.test(t);
}
function isUsefulGlobal(ev){
  const impact=String(ev.impact||'').toLowerCase();return impact.includes('high')&&GLOBAL_CONTEXT_RE.test(rawText(ev));
}
function rawDate(ev){
  if(ev.date)return String(ev.date).slice(0,10);
  const v=ev.time_utc||ev.datetime||ev.timestamp;
  if(v){const d=new Date(v);if(!Number.isNaN(d.getTime()))return d.toISOString().slice(0,10);}
  return '';
}
function key(ev){return String(ev.id||ev.event_id||ev.eventId||`${rawDate(ev)}|${ev.time_et||ev.time_utc||''}|${rawText(ev)}`);}
async function fetchRange(from,to){
  const u=`${API_BASE}/calendar?from=${ymd(from)}&to=${ymd(to)}&limit=500`;
  const r=await fetch(u,{headers:{Accept:'application/json','User-Agent':'MacroCal-Shared-Archive/1.0'}});
  if(!r.ok)throw new Error(`FinanceCalendar ${r.status}`);
  const j=await r.json();return Array.isArray(j)?j:(j.events||j.calendar||j.data||[]);
}
async function readJson(path,fallback){try{return JSON.parse(await fs.readFile(path,'utf8'));}catch{return fallback;}}
async function updateCalendar(){
  const old=await readJson('data/shared-feed.json',{events:[]});
  const map=new Map((old.events||[]).map(e=>[key(e),e]));
  const now=new Date();let cursor=addDays(now,-BACK_DAYS);const earliest=new Date(`${ARCHIVE_START}T00:00:00Z`);if(cursor<earliest)cursor=earliest;
  const end=addDays(now,FUTURE_DAYS);
  while(cursor<=end){const to=new Date(Math.min(addDays(cursor,RANGE_DAYS-1).getTime(),end.getTime()));const rows=await fetchRange(cursor,to);for(const ev of rows){const d=rawDate(ev);if(d&&d<ARCHIVE_START)continue;if(!(isUS(ev)||isUsefulGlobal(ev)))continue;map.set(key(ev),{...(map.get(key(ev))||{}),...ev});}cursor=addDays(to,1);}
  const events=[...map.values()].sort((a,b)=>`${rawDate(a)}|${a.time_et||a.time_utc||''}`.localeCompare(`${rawDate(b)}|${b.time_et||b.time_utc||''}`));
  await fs.writeFile('data/shared-feed.json',JSON.stringify({generated_at:new Date().toISOString(),events},null,2)+'\n');
  return events.length;
}
function gdeltDateToET(v){
  if(!v)return {date_et:'',time_et:''};
  const m=String(v).match(/(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})?Z?/);if(!m)return {date_et:'',time_et:''};
  const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0)));
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d);
  const o=Object.fromEntries(parts.map(p=>[p.type,p.value]));return {date_et:`${o.year}-${o.month}-${o.day}`,time_et:`${o.hour}:${o.minute}`};
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchWithRetry(url,options={},attempts=3,timeoutMs=20000){
  let lastErr;
  for(let i=1;i<=attempts;i++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const r=await fetch(url,{...options,signal:controller.signal});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      return r;
    }catch(err){
      lastErr=err;
      if(i<attempts)await sleep(1500*i);
    }finally{clearTimeout(timer);}
  }
  throw lastErr;
}
function decodeXml(s=''){return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function stripTags(s=''){return decodeXml(String(s).replace(/<[^>]+>/g,'')).trim();}
function xmlTag(block,tag){const m=String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));return m?stripTags(m[1]):'';}
const NEWS_TOPICS = [
  {tag:'Inflation', q:'US inflation CPI PCE prices shelter rents gasoline Federal Reserve inflation outlook when:7d'},
  {tag:'Fed / Rates', q:'Federal Reserve Powell Fed official statement interest rates Treasury yields rate cuts rate hikes when:7d'},
  {tag:'Trump / Policy', q:'Trump Truth Social post statement tariffs trade sanctions Federal Reserve Powell rates oil Iran China dollar Treasury when:7d'},
  {tag:'Oil / Supply', q:'oil crude supply OPEC Iran Strait of Hormuz Red Sea tanker shipping disruption when:7d'},
  {tag:'Geopolitical', q:'Iran Israel Middle East ceasefire peace attack escalation Ukraine Russia Taiwan markets when:7d'},
  {tag:'Trade / Sanctions', q:'US tariffs sanctions export controls trade war China imports markets when:7d'},
  {tag:'Fiscal risk', q:'US government shutdown debt ceiling Treasury financing fiscal markets when:7d'},
  {tag:'Financial stress', q:'bank stress credit stress liquidity crisis regional banks markets when:7d'},
  {tag:'Labor', q:'US labor market layoffs hiring job openings unemployment wages payrolls strikes when:7d'},
  {tag:'Growth / Demand', q:'US economy GDP growth business investment inventories trade demand outlook when:7d'},
  {tag:'Consumer', q:'US consumer spending retail credit cards retailers gasoline demand when:7d'},
  {tag:'Manufacturing', q:'US manufacturing factories supply chain Boeing aircraft orders capital goods tariffs when:7d'},
  {tag:'Housing / Mortgage', q:'US mortgage rates housing homebuilder housing starts building permits construction demand when:7d'},
  {tag:'Market move', q:'Nasdaq S&P 500 futures Treasury yields dollar oil market move catalyst when:7d'}
];
const TRUSTED_GOOGLE_SOURCES = [
  'Reuters','CNBC','Bloomberg','The Wall Street Journal','Wall Street Journal','Financial Times',
  'Associated Press','AP News','MarketWatch',"Barron's",'Yahoo Finance','Investing.com','Fortune','Axios','Fox Business','CBS News','NBC News','ABC News','The White House','Federal Reserve','U.S. Department of the Treasury'
];
function trustedGoogleSource(name=''){
  const n=String(name).trim().toLowerCase();
  return TRUSTED_GOOGLE_SOURCES.some(x=>n===x.toLowerCase() || n.includes(x.toLowerCase()));
}
async function fetchGoogleTopic(topic){
  const u=`https://news.google.com/rss/search?q=${encodeURIComponent(topic.q)}&hl=en-US&gl=US&ceid=US:en`;
  const r=await fetchWithRetry(u,{headers:{Accept:'application/rss+xml, application/xml, text/xml','User-Agent':'MacroCal-Market-Context/2.0'}},3,20000);
  const xml=await r.text();
  const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>m[1]);
  return items.slice(0,60).map(block=>{
    const rawTitle=xmlTag(block,'title');
    const link=xmlTag(block,'link');
    const pubDate=xmlTag(block,'pubDate');
    const source=xmlTag(block,'source');
    const title=rawTitle.replace(/\s+-\s+[^-]{2,80}$/,'').trim()||rawTitle;
    return {title,url:link,domain:source||'Google News',seendate:pubDate?new Date(pubDate).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'):'',provider:'Google News',topic_tag:topic.tag};
  });
}
async function fetchGdeltHeadlines(){
  const q='("S&P 500" OR Nasdaq OR "Treasury yields" OR futures OR Trump OR "Truth Social" OR Iran OR Israel OR "Middle East" OR "Strait of Hormuz" OR OPEC OR oil OR tariffs OR sanctions OR "government shutdown" OR "debt ceiling" OR "bank failure" OR Taiwan OR Ukraine OR Russia OR "Federal Reserve" OR Powell) (Fed OR inflation OR jobs OR oil OR war OR ceasefire OR peace OR attack OR strike OR sanctions OR tariffs OR trade OR disruption OR shutdown OR debt OR rates)';
  const u=`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=100&timespan=7d&sort=datedesc&format=json`;
  const r=await fetchWithRetry(u,{headers:{Accept:'application/json','User-Agent':'MacroCal-Market-Context/2.0'}},2,15000);
  const j=await r.json();return (j.articles||[]).map(a=>({...a,provider:'GDELT'}));
}
async function fetchHeadlines(){
  const all=[];
  // Primary context source: targeted external-news RSS searches, one topic at a time.
  // These are independent from the economic-calendar feed.
  for(const topic of NEWS_TOPICS){
    try{all.push(...await fetchGoogleTopic(topic));}
    catch(err){console.warn(`Google News ${topic.tag} refresh failed: ${err?.message||err}`);}
  }
  // Optional fallback/extra coverage only; a GDELT outage must never block the archive.
  try{all.push(...await fetchGdeltHeadlines());}catch(err){console.warn(`GDELT headline refresh failed: ${err?.message||err}`);}
  if(!all.length)throw new Error('All external headline sources failed');
  return all;
}
async function updateHeadlines(){
  const old=await readJson('data/market-headlines.json',{articles:[]});const map=new Map((old.articles||[]).map(a=>[a.url||a.title,a]));
  let rows=[];
  try{
    rows=await fetchHeadlines();
  }catch(err){
    console.warn(`Headline refresh skipped: ${err?.message||err}. Keeping ${map.size} previously stored headlines.`);
    return map.size;
  }
  for(const a of rows){
    const domain=String(a.domain||'').trim();
    const fromGoogle=a.provider==='Google News';
    if(fromGoogle && !trustedGoogleSource(domain))continue;
    if(!fromGoogle){const dl=domain.toLowerCase();if(!TRUSTED_DOMAINS.some(d=>dl===d||dl.endsWith('.'+d)))continue;}
    const title=String(a.title||'').trim();if(!title||!a.url)continue;
    const effectReported=MARKET_MOVE_RE.test(title);
    const inferredCatalyst=catalystTag(title);
    const topicTag=String(a.topic_tag||'').trim();
    const catalyst=topicTag||inferredCatalyst;
    if(!effectReported&&!catalyst)continue;
    const et=gdeltDateToET(a.seendate||a.date||a.datetime);
    const item={title,url:a.url,domain,seendate:a.seendate||'',date_et:et.date_et,time_et:et.time_et,effect_reported:effectReported,major_catalyst:Boolean(catalyst),catalyst_tag:catalyst||'',provider:a.provider||'',source:domain};
    map.set(item.url||item.title,{...(map.get(item.url||item.title)||{}),...item});
  }
  const articles=[...map.values()].sort((a,b)=>String(b.seendate||'').localeCompare(String(a.seendate||'')));
  await fs.writeFile('data/market-headlines.json',JSON.stringify({generated_at:new Date().toISOString(),articles},null,2)+'\n');return articles.length;
}
// Refresh the economic calendar and market headlines independently. A failure in one
// upstream source must never prevent the other dataset from updating.
const [calendarResult, headlineResult] = await Promise.allSettled([
  updateCalendar(),
  updateHeadlines()
]);

let eventCount='unchanged';
let headlineCount='unchanged';
if(calendarResult.status==='fulfilled'){
  eventCount=calendarResult.value;
}else{
  console.warn(`Calendar refresh failed: ${calendarResult.reason?.message||calendarResult.reason}. Keeping the previously stored shared calendar archive.`);
}
if(headlineResult.status==='fulfilled'){
  headlineCount=headlineResult.value;
}else{
  console.warn(`Headline refresh failed: ${headlineResult.reason?.message||headlineResult.reason}. Keeping the previously stored headline archive.`);
}
console.log(`Shared archive: ${eventCount} calendar rows; ${headlineCount} retained market-impact headlines.`);
