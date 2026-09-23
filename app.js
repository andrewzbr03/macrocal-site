const API_BASE = 'https://www.financecalendar.com/wp-json/fc/v1';
const CACHE_KEY = 'macroCalCoverageV10';
const CACHE_TTL_MS = 60 * 60 * 1000;
const ARCHIVE_START_DATE = '2026-09-23'; // shared live archive begins here; older verified chat history remains built in
const RANGE_DAYS = 14; // small windows avoid global-feed truncation and stay well below the provider's 92-day max
const CATCHUP_DAYS_WITHOUT_CACHE = 90; // enough to catch releases if the site was closed for a while
const EMPTY_WINDOWS_TO_STOP = 3; // future scan stops after repeated empty published windows
const SCAN_SAFETY_WINDOWS = 80;  // emergency loop guard only

const FILTER_DEFS = [
  { id:'durable', label:'Durable Goods', terms:['durable goods','durable goods orders'], patterns:[/\bdurable goods(?: orders)?\b/i] },
  { id:'michigan', label:'Michigan Sentiment', terms:['michigan sentiment','consumer sentiment','university of michigan'], patterns:[/\bmichigan (?:consumer )?sentiment\b/i,/\buniversity of michigan\b/i,/\bmichigan\b.*\binflation expectations?\b/i] },
  { id:'jolts', label:'JOLTS', terms:['jolts','job openings'], patterns:[/\bjolts\b/i,/\bjob openings\b/i] },
  { id:'confidence', label:'Consumer Confidence', terms:['consumer confidence','conference board'], patterns:[/\b(?:cb|conference board) consumer confidence\b/i,/\bconsumer confidence\b/i] },
  { id:'adp', label:'ADP Employment', terms:['adp','private employment'], patterns:[/\badp\b.*\b(?:employment|payroll|pay)\b/i,/\bprivate employment\b/i] },
  { id:'pce', label:'PCE Inflation', terms:['pce','pce inflation','personal consumption expenditures'], patterns:[/\b(?:core )?pce\b/i,/\bpersonal consumption expenditures?\b/i] },
  { id:'gdp', label:'GDP', terms:['gdp','gross domestic product'], patterns:[/\bgdp\b/i,/\bgross domestic product\b/i] },
  { id:'ism-manufacturing', label:'ISM Manufacturing', terms:['ism manufacturing','manufacturing pmi'], patterns:[/\bism\b.*\bmanufacturing\b/i,/\bmanufacturing\b.*\bism\b/i] },
  { id:'jobs', label:'NFP / Jobs Report', terms:['nfp','nonfarm payrolls','jobs report','unemployment','wages'], patterns:[/\bnon[- ]?farm payrolls?\b/i,/\bnfp\b/i,/\bemployment situation\b/i,/\bunemployment rate\b/i,/\baverage hourly earnings\b/i] },
  { id:'ism-services', label:'ISM Services', terms:['ism services','services pmi'], patterns:[/\bism\b.*\bservices?\b/i,/\bservices?\b.*\bism\b/i,/\bism\b.*\bnon[- ]manufacturing\b/i] },
  { id:'fomc-minutes', label:'FOMC Minutes', terms:['fomc minutes','fed minutes'], patterns:[/\bfomc\b.*\bminutes\b/i,/\bfederal reserve\b.*\bminutes\b/i], requiresFed:true },
  { id:'cpi', label:'CPI', terms:['cpi','consumer price index'], patterns:[/\b(?:core )?cpi\b/i,/\bconsumer price index\b/i] },
  { id:'ppi', label:'PPI', terms:['ppi','producer price index'], patterns:[/\b(?:core )?ppi\b/i,/\bproducer price index\b/i] },
  { id:'retail', label:'Retail Sales', terms:['retail sales'], patterns:[/\b(?:core )?retail sales\b/i] },
  { id:'housing-starts', label:'Housing Starts', terms:['housing starts'], patterns:[/\bhousing starts\b/i] },
  { id:'permits', label:'Building Permits', terms:['building permits'], patterns:[/\bbuilding permits\b/i] },
  { id:'fomc-decision', label:'FOMC Rate Decision', terms:['fomc rate decision','fed rate decision','interest rate decision'], patterns:[/\bfomc\b.*\b(?:rate|interest rate) decision\b/i,/\bfederal reserve\b.*\b(?:rate|interest rate) decision\b/i,/\bfed\b.*\b(?:rate|interest rate) decision\b/i,/\bfederal funds rate\b/i], requiresFed:true },
  { id:'fed-presser', label:'Fed Press Conference', terms:['fed press conference','fomc press conference'], patterns:[/\bfomc\b.*\bpress conference\b/i,/\bfederal reserve\b.*\bpress conference\b/i,/\bfed chair\b.*\bpress conference\b/i,/\bfed\b.*\bpress conference\b/i], requiresFed:true },
  { id:'eci', label:'Employment Cost Index', terms:['employment cost index','eci'], patterns:[/\bemployment cost index\b/i,/\beci\b/i] },
  { id:'claims', label:'Initial Jobless Claims', terms:['initial jobless claims','jobless claims'], patterns:[/\binitial jobless claims\b/i,/^jobless claims$/i] }
];

const IMPACTS = {
  durable:'High', michigan:'Medium', jolts:'High', confidence:'High', adp:'High', pce:'Very High', gdp:'Very High',
  'ism-manufacturing':'High', jobs:'Very High', 'ism-services':'High', 'fomc-minutes':'High', cpi:'Very High', ppi:'High',
  retail:'High', 'housing-starts':'Medium', permits:'Medium', 'fomc-decision':'Extremely High', 'fed-presser':'Extremely High',
  eci:'High', claims:'Medium'
};
const FAMILY_META = Object.fromEntries(FILTER_DEFS.map(d => [d.id,{label:d.label,impact:IMPACTS[d.id]||'Medium'}]));

// Exact report structure and research links approved from Trading.docx.
const METRIC_SPECS = {
  durable:[
    {id:'headline',label:'Headline Durable Goods',patterns:[/durable goods(?!.*core)/i],source:'https://www.investing.com/economic-calendar/durable-goods-orders-86',official:'https://www.census.gov/manufacturing/m3/adv/current/index.html',primary:true},
    {id:'core',label:'Core Durable Goods',patterns:[/core durable/i,/durable goods.*ex.*transport/i],source:'https://www.investing.com/economic-calendar/core-durable-goods-orders-59',official:'https://www.census.gov/manufacturing/m3/adv/current/index.html'}
  ],
  michigan:[
    {id:'sentiment',label:'Consumer Sentiment',patterns:[/consumer sentiment/i,/michigan sentiment/i],source:'https://www.investing.com/economic-calendar/michigan-consumer-sentiment-320',official:'https://www.sca.isr.umich.edu/',primary:true},
    {id:'expectations',label:'Consumer Expectations',patterns:[/consumer expectations/i,/michigan.*expectations(?!.*inflation)/i],source:'https://www.investing.com/economic-calendar/michigan-consumer-expectations-900',official:'https://www.sca.isr.umich.edu/'},
    {id:'conditions',label:'Current Conditions',patterns:[/current conditions/i],source:'https://www.investing.com/economic-calendar/-901',official:'https://www.sca.isr.umich.edu/'},
    {id:'infl1y',label:'1-Year Inflation Expectations',patterns:[/1.?year.*inflation/i,/inflation expectations(?!.*5)/i],source:'https://www.investing.com/economic-calendar/michigan-inflation-expectations-389',official:'https://www.sca.isr.umich.edu/'},
    {id:'infl5y',label:'5-Year Inflation Expectations',patterns:[/5.?year.*inflation/i,/long.?term.*inflation/i],source:'https://www.investing.com/economic-calendar/united-states-michigan-5-year-inflation-expectations-1568',official:'https://www.sca.isr.umich.edu/'}
  ],
  jolts:[{id:'openings',label:'JOLTS Job Openings',patterns:[/jolts/i,/job openings/i],source:'https://www.investing.com/economic-calendar/united-states-jolts-job-openings-1057',official:'https://www.bls.gov/news.release/jolts.htm',primary:true}],
  confidence:[{id:'confidence',label:'Consumer Confidence',patterns:[/consumer confidence/i],source:'https://www.investing.com/economic-calendar/cb--48',official:'https://www.conference-board.org/topics/consumer-confidence',primary:true}],
  adp:[
    {id:'employment',label:'ADP Nonfarm Employment Change',patterns:[/adp.*(?:employment|payroll)/i,/private employment/i],source:'https://www.investing.com/economic-calendar/adp-nonfarm-employment-change-1',official:'https://adpemploymentreport.com/',primary:true},
    {id:'stayers',label:'Pay Insights — Job Stayers',patterns:[/job.?stayers/i],source:'https://payinsights.adp.com/',official:'https://payinsights.adp.com/',noForecast:true},
    {id:'changers',label:'Pay Insights — Job Changers',patterns:[/job.?changers/i],source:'https://payinsights.adp.com/',official:'https://payinsights.adp.com/',noForecast:true}
  ],
  pce:[
    {id:'core_mom',label:'Core PCE MoM',patterns:[/core.*pce.*(?:mom|m\/m|month)/i,/pce.*core.*(?:mom|m\/m|month)/i],source:'https://www.investing.com/economic-calendar/indeks-harga-belanja-personal-%28pce%29-inti-61',official:'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy',primary:true,summary:{prefix:'core',period:'mom'}},
    {id:'core_yoy',label:'Core PCE YoY',patterns:[/core.*pce.*(?:yoy|y\/y|year)/i,/pce.*core.*(?:yoy|y\/y|year)/i],source:'https://www.investing.com/economic-calendar/core-pce-price-index-905',official:'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy',summary:{prefix:'core',period:'yoy'}},
    {id:'headline_mom',label:'Headline PCE MoM',patterns:[/(?:headline )?pce.*(?:mom|m\/m|month)/i],exclude:[/core/i],source:'https://www.investing.com/economic-calendar/pce-price-index-904',official:'https://www.bea.gov/data/personal-consumption-expenditures-price-index',summary:{prefix:'headline',period:'mom'}},
    {id:'headline_yoy',label:'Headline PCE YoY',patterns:[/(?:headline )?pce.*(?:yoy|y\/y|year)/i],exclude:[/core/i],source:'https://www.investing.com/economic-calendar/pce-price-index-906',official:'https://www.bea.gov/data/personal-consumption-expenditures-price-index',summary:{prefix:'headline',period:'yoy'}}
  ],
  gdp:[{id:'gdp_qoq',label:'GDP QoQ',patterns:[/gdp.*(?:qoq|q\/q|quarter|annual)/i,/gross domestic product/i],source:'https://www.investing.com/economic-calendar/pil-375',official:'https://www.bea.gov/data/gdp/gross-domestic-product',primary:true}],
  'ism-manufacturing':[
    {id:'headline',label:'ISM Manufacturing PMI',patterns:[/ism.*manufacturing.*pmi/i,/manufacturing pmi/i],source:'https://www.investing.com/economic-calendar/ism-manufacturing-pmi-173',official:'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/',primary:true},
    {id:'prices',label:'ISM Manufacturing Prices',patterns:[/manufacturing.*prices/i,/ism.*prices/i],source:'https://www.investing.com/economic-calendar/ism---174',official:'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/'},
    {id:'orders',label:'ISM Manufacturing New Orders',patterns:[/new orders/i],source:'https://www.investing.com/economic-calendar/ism-1483',official:'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/'},
    {id:'employment',label:'ISM Manufacturing Employment',patterns:[/manufacturing.*employment/i,/ism.*employment/i],source:'https://www.investing.com/economic-calendar/ism-1046',official:'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/'}
  ],
  jobs:[
    {id:'nfp',label:'Nonfarm Payrolls (NFP)',patterns:[/non.?farm payroll/i,/\bnfp\b/i],source:'https://www.investing.com/economic-calendar/nonfarm-payrolls-227',official:'https://www.bls.gov/news.release/empsit.htm',primary:true},
    {id:'unemployment',label:'Unemployment Rate',patterns:[/unemployment rate/i],source:'https://www.investing.com/economic-calendar/unemployment-rate-300',official:'https://www.bls.gov/news.release/empsit.htm'},
    {id:'wages',label:'Average Hourly Earnings MoM',patterns:[/average hourly earnings/i,/hourly earnings/i],source:'https://www.investing.com/economic-calendar/average-hourly-earnings-8',official:'https://www.bls.gov/news.release/empsit.htm'}
  ],
  'ism-services':[
    {id:'headline',label:'Headline ISM Services PMI',patterns:[/ism.*services.*pmi/i,/non.?manufacturing.*pmi/i],source:'https://www.investing.com/economiccalendar/ism-non-manufacturing-pmi-176',official:'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/',primary:true},
    {id:'prices',label:'ISM Services Prices',patterns:[/services.*prices/i,/non.?manufacturing.*prices/i],source:'https://www.investing.com/economic-calendar/ism-non-manufacturing-prices-1049',official:'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/'},
    {id:'employment',label:'ISM Services Employment',patterns:[/services.*employment/i,/non.?manufacturing.*employment/i],source:'https://www.investing.com/economic-calendar/ism-non-manufacturing-employment-1048',official:'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/'}
  ],
  'fomc-minutes':[],
  cpi:[
    {id:'core_mom',label:'Core CPI MoM',patterns:[/core.*cpi.*(?:mom|m\/m|month)/i],source:'https://www.investing.com/economiccalendar/core-cpi-56',official:'https://www.bls.gov/news.release/cpi.htm',primary:true,summary:{prefix:'core',period:'mom'}},
    {id:'core_yoy',label:'Core CPI YoY',patterns:[/core.*cpi.*(?:yoy|y\/y|year)/i],source:'https://www.investing.com/economic-calendar/core-cpi-736',official:'https://www.bls.gov/news.release/cpi.htm',summary:{prefix:'core',period:'yoy'}},
    {id:'headline_mom',label:'Headline CPI MoM',patterns:[/(?:headline )?cpi.*(?:mom|m\/m|month)/i],exclude:[/core/i],source:'https://www.investing.com/economic-calendar/ci-69',official:'https://www.bls.gov/news.release/cpi.htm',summary:{prefix:'headline',period:'mom'}},
    {id:'headline_yoy',label:'Headline CPI YoY',patterns:[/(?:headline )?cpi.*(?:yoy|y\/y|year)/i],exclude:[/core/i],source:'https://www.investing.com/economiccalendar/cpi-733',official:'https://www.bls.gov/news.release/cpi.htm',summary:{prefix:'headline',period:'yoy'}}
  ],
  ppi:[
    {id:'core_mom',label:'Core PPI MoM',patterns:[/core.*ppi.*(?:mom|m\/m|month)/i],source:'https://www.investing.com/economic-calendar/ppi-62',official:'https://www.bls.gov/news.release/ppi.htm',primary:true,summary:{prefix:'core',period:'mom'}},
    {id:'core_yoy',label:'Core PPI YoY',patterns:[/core.*ppi.*(?:yoy|y\/y|year)/i],source:'https://www.investing.com/economic-calendar/ppi-735',official:'https://www.bls.gov/news.release/ppi.htm',summary:{prefix:'core',period:'yoy'}},
    {id:'headline_mom',label:'Headline PPI MoM',patterns:[/(?:headline )?ppi.*(?:mom|m\/m|month)/i],exclude:[/core/i],source:'https://www.investing.com/economiccalendar/ppi-238',official:'https://www.bls.gov/news.release/ppi.htm',summary:{prefix:'headline',period:'mom'}},
    {id:'headline_yoy',label:'Headline PPI YoY',patterns:[/(?:headline )?ppi.*(?:yoy|y\/y|year)/i],exclude:[/core/i],source:'https://www.investing.com/economic-calendar/ppi-734',official:'https://www.bls.gov/news.release/ppi.htm',summary:{prefix:'headline',period:'yoy'}}
  ],
  retail:[
    {id:'core',label:'Core Retail Sales MoM',patterns:[/core retail sales/i,/retail sales.*ex.*auto/i],source:'https://www.investing.com/economic-calendar/core-retail-sales-63',official:'https://www.census.gov/retail/sales.html',primary:true},
    {id:'headline',label:'Headline Retail Sales MoM',patterns:[/retail sales/i],exclude:[/core/i,/ex.*auto/i],source:'https://www.investing.com/economiccalendar/retail-sales-256',official:'https://www.census.gov/retail/sales.html'}
  ],
  'housing-starts':[{id:'starts',label:'Housing Starts',patterns:[/housing starts/i],source:'https://www.investing.com/economic-calendar/---151',official:'https://www.census.gov/construction/nrc/index.html',primary:true}],
  permits:[{id:'permits',label:'Building Permits',patterns:[/building permits/i],source:'https://www.investing.com/economic-calendar/building-permits-885',official:'https://www.census.gov/construction/nrc/index.html',primary:true}],
  'fomc-decision':[{id:'rate',label:'Fed Interest Rate Decision',patterns:[/rate decision/i,/federal funds rate/i],source:'https://www.investing.com/economic-calendar/interest-rate-decision-168',official:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',primary:true}],
  'fed-presser':[],
  eci:[{id:'eci',label:'Employment Cost Index QoQ',patterns:[/employment cost index/i,/\beci\b/i],source:'https://www.investing.com/economic-calendar/employment-cost-index-331',official:'https://www.bls.gov/news.release/eci.htm',primary:true}],
  claims:[{id:'claims',label:'Initial Jobless Claims',patterns:[/initial jobless claims/i,/^jobless claims$/i],source:'https://www.investing.com/economic-calendar/initial-jobless-claims-294',official:'https://oui.doleta.gov/unemploy/claims.asp/',primary:true}]
};

const SPECIAL_LINKS = {
  'fomc-minutes':'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  'fed-presser':'https://www.federalreserve.gov/live-broadcast.htm'
};
const SPECIAL_INVESTING_LINKS = {
  'fomc-minutes':'https://in.investing.com/economic-calendar/fomc-minutes-108',
  'fed-presser':'https://www.investing.com/economic-calendar/u.s.-federal-reserve-%28fed%29%3As-presskonferens-1692'
};

const FED_CONTEXT_RE = /\b(?:fomc|federal reserve|fed chair|fed governor|fed president|fed|federal funds)\b/i;
const FOREIGN_CENTRAL_BANK_RE = /\b(?:riksbank|ecb|european central bank|bank of england|boe|bank of japan|boj|reserve bank of australia|rba|reserve bank of new zealand|rbnz|bank of canada|boc|swiss national bank|snb|norges bank|people'?s bank of china|pboc|bank of korea)\b/i;
const US_COUNTRY_RE = /^(?:us|usa|u s|u\.s\.|united states|united states of america)$/i;
const US_TITLE_RE = /^(?:us|u\.s\.|united states)\b/i;
const EXTRA_RELEVANCE_RE = /\b(?:trade balance|industrial production|empire state|philly fed|philadelphia fed|new home sales|existing home sales|pending home sales|import prices|export prices|productivity|unit labor costs|beige book|factory orders|business inventories|construction spending|fed chair|fed governor|fed president|federal reserve.*speech|powell.*speech|treasury refunding|treasury.*auction|2.?year.*auction|5.?year.*auction|7.?year.*auction|10.?year.*auction|30.?year.*auction)\b/i;
const GLOBAL_CONTEXT_RE = /\b(?:ecb|european central bank|bank of england|boe|bank of japan|boj|pboc|people'?s bank of china|bank of canada|boc|reserve bank of australia|rba|reserve bank of new zealand|rbnz|swiss national bank|snb|riksbank|norges bank|china.*(?:gdp|cpi|pmi)|euro(?:zone| area).*(?:gdp|cpi|pmi)|(?:central bank|interest )?rate decision|opec|crude oil|geopolit|government shutdown|debt ceiling)\b/i;

// Verified near-term fallback; live data can enrich it and add history/future occurrences.
const CANONICAL_SEED = [
  ['2026-09-24','08:30','claims','Initial Jobless Claims','Medium'],
  ['2026-09-25','08:30','durable','Durable Goods Orders','High'],
  ['2026-09-25','10:00','michigan','Michigan Consumer Sentiment — Final','Medium'],
  ['2026-09-29','10:00','jolts','JOLTS Job Openings','High'],
  ['2026-09-29','10:00','confidence','Consumer Confidence','High'],
  ['2026-09-30','08:15','adp','ADP Private Employment','High'],
  ['2026-09-30','08:30','pce','PCE Inflation','Very High'],
  ['2026-09-30','08:30','gdp','Q2 GDP — Final Estimate','Medium-High'],
  ['2026-10-01','08:30','claims','Initial Jobless Claims','Medium'],
  ['2026-10-01','10:00','ism-manufacturing','ISM Manufacturing PMI','High'],
  ['2026-10-02','08:30','jobs','NFP + Unemployment + Wages','Very High'],
  ['2026-10-05','10:00','ism-services','ISM Services PMI','High'],
  ['2026-10-07','14:00','fomc-minutes','FOMC Minutes','High'],
  ['2026-10-08','08:30','claims','Initial Jobless Claims','Medium'],
  ['2026-10-09','10:00','michigan','Michigan Consumer Sentiment — Preliminary','High'],
  ['2026-10-14','08:30','cpi','CPI','Very High'],
  ['2026-10-15','08:30','claims','Initial Jobless Claims','Medium'],
  ['2026-10-15','08:30','ppi','PPI','High'],
  ['2026-10-15','08:30','retail','Retail Sales','High'],
  ['2026-10-20','08:30','housing-starts','Housing Starts','Medium'],
  ['2026-10-20','08:30','permits','Building Permits','Medium'],
  ['2026-10-22','08:30','claims','Initial Jobless Claims','Medium'],
  ['2026-10-23','10:00','michigan','Michigan Consumer Sentiment — Final','Medium'],
  ['2026-10-27','08:30','durable','Durable Goods Orders','High'],
  ['2026-10-27','10:00','confidence','Consumer Confidence','High'],
  ['2026-10-28','14:00','fomc-decision','FOMC Rate Decision','Extremely High'],
  ['2026-10-28','14:30','fed-presser','Fed Press Conference','Extremely High'],
  ['2026-10-29','08:30','claims','Initial Jobless Claims','Medium'],
  ['2026-10-29','08:30','gdp','Q3 GDP — First Estimate','Very High'],
  ['2026-10-29','08:30','pce','PCE Inflation','Very High'],
  ['2026-10-30','08:30','eci','Employment Cost Index','High']
].map((r,i)=>({date:r[0],time_et:r[1],filterId:r[2],name:r[3],impact:r[4],url:primarySource(r[2]),country:'United States',currency:'USD',canonical:true,id:`seed-${i}-${r[0]}-${r[2]}`}));

// Historical archive transcribed from verified historical values already collected in this ChatGPT conversation.
function makeChatHistoryEvent(row, idx){
  const specs=METRIC_SPECS[row.filterId]||[];
  const components=(row.metrics||[]).map(m=>{const spec=specs.find(s=>s.id===m[0]);return {name:spec?.label||m[0],actual:m[1],forecast:m[2],consensus:m[2],previous:m[3],prior:m[3],time_et:row.time_et};});
  const primary=components.find(c=>{const s=specs.find(x=>x.label===c.name);return s?.primary;})||components[0]||{};
  return {id:`chat-hist-${idx}-${row.date}-${row.filterId}`,date:row.date,time_et:row.time_et,filterId:row.filterId,name:row.name,impact:row.impact,url:primarySource(row.filterId),country:'United States',currency:'USD',chatHistorical:true,sourceStatus:'Chat history · verified source data',actual:primary.actual,forecast:primary.forecast,consensus:primary.forecast,previous:primary.previous,prior:primary.previous,components};
}
const HISTORICAL_CHAT_ROWS = [["cpi","2026-01-13","08:30","CPI","Very High",[["core_mom","0.2%","0.3%","0.2%"],["core_yoy","2.6%","2.7%","2.6%"],["headline_mom","0.3%","0.3%","0.3%"],["headline_yoy","2.7%","2.7%","2.7%"]]],["cpi","2026-02-13","08:30","CPI","Very High",[["core_mom","0.3%","0.3%","0.2%"],["core_yoy","2.5%","2.5%","2.6%"],["headline_mom","0.2%","0.3%","0.3%"],["headline_yoy","2.4%","2.5%","2.7%"]]],["cpi","2026-03-11","08:30","CPI","Very High",[["core_mom","0.2%","0.2%","0.3%"],["core_yoy","2.5%","2.5%","2.5%"],["headline_mom","0.3%","0.3%","0.2%"],["headline_yoy","2.4%","2.4%","2.4%"]]],["cpi","2026-04-10","08:30","CPI","Very High",[["core_mom","0.2%","0.3%","0.2%"],["core_yoy","2.6%","2.7%","2.5%"],["headline_mom","0.9%","1.0%","0.3%"],["headline_yoy","3.3%","3.4%","2.4%"]]],["cpi","2026-05-12","08:30","CPI","Very High",[["core_mom","0.4%","0.3%","0.2%"],["core_yoy","2.8%","2.7%","2.6%"],["headline_mom","0.6%","0.6%","0.9%"],["headline_yoy","3.8%","3.7%","3.3%"]]],["cpi","2026-06-10","08:30","CPI","Very High",[["core_mom","0.2%","0.3%","0.4%"],["core_yoy","2.9%","2.9%","2.8%"],["headline_mom","0.5%","0.5%","0.6%"],["headline_yoy","4.2%","4.2%","3.8%"]]],["cpi","2026-07-14","08:30","CPI","Very High",[["core_mom","0.0%","0.2%","0.2%"],["core_yoy","2.6%","2.8%","2.9%"],["headline_mom","-0.4%","-0.1%","0.5%"],["headline_yoy","3.5%","3.8%","4.2%"]]],["cpi","2026-08-12","08:30","CPI","Very High",[["core_mom","0.2%","0.2%","0.0%"],["core_yoy","2.5%","2.5%","2.6%"],["headline_mom","0.1%","0.1%","-0.4%"],["headline_yoy","3.4%","3.4%","3.5%"]]],["cpi","2026-09-11","08:30","CPI","Very High",[["core_mom","0.3%","0.2%","0.2%"],["core_yoy","2.4%","2.4%","2.5%"],["headline_mom","0.4%","0.4%","0.1%"],["headline_yoy","3.4%","3.4%","3.4%"]]],["ppi","2026-01-30","08:30","PPI","High",[["core_mom","0.7%","0.2%","0.0%"],["core_yoy","3.3%","2.9%","3.1%"],["headline_mom","0.5%","0.2%","0.2%"],["headline_yoy","3.0%","2.7%","3.0%"]]],["ppi","2026-02-27","08:30","PPI","High",[["core_mom","0.8%","0.3%","0.6%"],["core_yoy","3.6%","3.0%","3.3%"],["headline_mom","0.5%","0.3%","0.4%"],["headline_yoy","2.9%","2.6%","3.0%"]]],["ppi","2026-03-18","08:30","PPI","High",[["core_mom","0.5%","0.3%","0.8%"],["core_yoy","3.9%","3.7%","3.5%"],["headline_mom","0.7%","0.3%","0.5%"],["headline_yoy","3.4%","2.9%","2.9%"]]],["ppi","2026-04-14","08:30","PPI","High",[["core_mom","0.1%","0.4%","0.3%"],["core_yoy","3.8%","4.2%","3.8%"],["headline_mom","0.5%","1.1%","0.5%"],["headline_yoy","4.0%","4.6%","3.4%"]]],["ppi","2026-05-13","08:30","PPI","High",[["core_mom","1.0%","0.3%","0.2%"],["core_yoy","5.2%","4.3%","4.0%"],["headline_mom","1.4%","0.5%","0.7%"],["headline_yoy","6.0%","4.9%","4.3%"]]],["ppi","2026-06-11","08:30","PPI","High",[["core_mom","0.4%","0.5%","0.7%"],["core_yoy","4.9%","5.4%","4.9%"],["headline_mom","1.1%","0.7%","1.1%"],["headline_yoy","6.5%","6.4%","5.7%"]]],["ppi","2026-07-15","08:30","PPI","High",[["core_mom","0.2%","0.3%","0.1%"],["core_yoy","4.7%","5.2%","4.6%"],["headline_mom","-0.3%","0.0%","0.6%"],["headline_yoy","5.5%","6.2%","6.0%"]]],["ppi","2026-08-13","08:30","PPI","High",[["core_mom","0.2%","0.3%","0.4%"],["core_yoy","4.2%","4.2%","4.7%"],["headline_mom","0.0%","0.2%","-0.1%"],["headline_yoy","4.7%","4.9%","5.5%"]]],["ppi","2026-09-10","08:30","PPI","High",[["core_mom","0.2%","0.3%","0.3%"],["core_yoy","4.6%","4.6%","4.3%"],["headline_mom","0.4%","0.4%","0.1%"],["headline_yoy","5.4%","5.3%","4.8%"]]],["pce","2026-01-22","08:30","PCE Inflation","Very High",[["core_mom","0.2%","0.2%","0.2%"],["core_yoy","2.8%","2.8%","2.7%"],["headline_mom","0.2%","0.2%","0.2%"],["headline_yoy","2.8%","2.8%","2.7%"]]],["pce","2026-02-20","08:30","PCE Inflation","Very High",[["core_mom","0.4%","0.3%","0.2%"],["core_yoy","3.0%","2.9%","2.8%"],["headline_mom","0.4%","0.3%","0.2%"],["headline_yoy","2.9%","2.8%","2.8%"]]],["pce","2026-03-13","08:30","PCE Inflation","Very High",[["core_mom","0.4%","0.4%","0.4%"],["core_yoy","3.1%","3.1%","3.0%"],["headline_mom","0.3%","0.3%","0.4%"],["headline_yoy","2.8%","2.9%","2.9%"]]],["pce","2026-04-09","08:30","PCE Inflation","Very High",[["core_mom","0.4%","0.4%","0.4%"],["core_yoy","3.0%","3.0%","3.1%"],["headline_mom","0.4%","0.4%","0.3%"],["headline_yoy","2.8%","2.8%","2.8%"]]],["pce","2026-04-30","08:30","PCE Inflation","Very High",[["core_mom","0.3%","0.3%","0.4%"],["core_yoy","3.2%","3.2%","3.0%"],["headline_mom","0.7%","0.7%","0.4%"],["headline_yoy","3.5%","3.5%","2.8%"]]],["pce","2026-05-28","08:30","PCE Inflation","Very High",[["core_mom","0.2%","0.3%","0.3%"],["core_yoy","3.3%","3.3%","3.2%"],["headline_mom","0.4%","0.5%","0.7%"],["headline_yoy","3.8%","3.8%","3.5%"]]],["pce","2026-06-25","08:30","PCE Inflation","Very High",[["core_mom","0.3%","0.3%","0.3%"],["core_yoy","3.4%","3.4%","3.3%"],["headline_mom","0.4%","0.5%","0.4%"],["headline_yoy","4.1%","4.1%","3.8%"]]],["pce","2026-07-30","08:30","PCE Inflation","Very High",[["core_mom","0.1%","0.2%","0.3%"],["core_yoy","3.3%","3.3%","3.4%"],["headline_mom","-0.1%","-0.1%","0.5%"],["headline_yoy","3.7%","3.7%","4.1%"]]],["pce","2026-08-26","08:30","PCE Inflation","Very High",[["core_mom","0.2%","0.2%","0.1%"],["core_yoy","3.3%","3.3%","3.3%"],["headline_mom","0.2%","0.1%","-0.1%"],["headline_yoy","3.7%","3.6%","3.7%"]]],["jobs","2026-01-09","08:30","NFP + Unemployment + Wages","Very High",[["nfp","50K","66K","56K"],["unemployment","4.4%","4.5%","4.5%"],["wages","0.3%","0.3%","0.2%"]]],["jobs","2026-02-11","08:30","NFP + Unemployment + Wages","Very High",[["nfp","130K","66K","48K"],["unemployment","4.3%","4.4%","4.4%"],["wages","0.4%","0.3%","0.1%"]]],["jobs","2026-03-06","08:30","NFP + Unemployment + Wages","Very High",[["nfp","-92K","58K","126K"],["unemployment","4.4%","4.3%","4.3%"],["wages","0.4%","0.3%","0.4%"]]],["jobs","2026-04-03","08:30","NFP + Unemployment + Wages","Very High",[["nfp","178K","65K","-133K"],["unemployment","4.3%","4.4%","4.4%"],["wages","0.2%","0.3%","0.4%"]]],["jobs","2026-05-08","08:30","NFP + Unemployment + Wages","Very High",[["nfp","115K","65K","185K"],["unemployment","4.3%","4.3%","4.3%"],["wages","0.2%","0.3%","0.2%"]]],["jobs","2026-06-05","08:30","NFP + Unemployment + Wages","Very High",[["nfp","172K","85K","179K"],["unemployment","4.3%","4.3%","4.3%"],["wages","0.3%","0.3%","0.2%"]]],["jobs","2026-07-02","08:30","NFP + Unemployment + Wages","Very High",[["nfp","57K","114K","129K"],["unemployment","4.2%","4.3%","4.3%"],["wages","0.3%","0.3%","0.3%"]]],["jobs","2026-08-07","08:30","NFP + Unemployment + Wages","Very High",[["nfp","-23K","85K","20K"],["unemployment","4.1%","4.2%","4.2%"],["wages","0.1%","0.3%","0.3%"]]],["jobs","2026-09-04","08:30","NFP + Unemployment + Wages","Very High",[["nfp","162K","55K","21K"],["unemployment","4.1%","4.1%","4.1%"],["wages","0.3%","0.3%","0.2%"]]],["jolts","2026-01-07","10:00","JOLTS Job Openings","High",[["openings","7.146M","7.610M","7.449M"]]],["jolts","2026-02-05","10:00","JOLTS Job Openings","High",[["openings","6.542M","7.200M","6.928M"]]],["jolts","2026-03-13","10:00","JOLTS Job Openings","High",[["openings","6.946M","6.760M","6.550M"]]],["jolts","2026-03-31","10:00","JOLTS Job Openings","High",[["openings","6.882M","6.890M","7.240M"]]],["jolts","2026-05-05","10:00","JOLTS Job Openings","High",[["openings","6.866M","6.860M","6.922M"]]],["jolts","2026-06-02","10:00","JOLTS Job Openings","High",[["openings","7.618M","6.860M","6.887M"]]],["jolts","2026-06-30","10:00","JOLTS Job Openings","High",[["openings","7.594M","7.280M","7.585M"]]],["jolts","2026-08-04","10:00","JOLTS Job Openings","High",[["openings","7.359M","7.440M","7.537M"]]],["jolts","2026-09-01","10:00","JOLTS Job Openings","High",[["openings","7.271M","7.330M","7.182M"]]],["adp","2026-01-07","08:15","ADP Private Employment","High",[["employment","41K","49K","-29K"]]],["adp","2026-02-04","08:15","ADP Private Employment","High",[["employment","22K","46K","37K"]]],["adp","2026-03-04","08:15","ADP Private Employment","High",[["employment","63K","50K","11K"]]],["adp","2026-04-01","08:15","ADP Private Employment","High",[["employment","62K","41K","66K"]]],["adp","2026-05-06","08:15","ADP Private Employment","High",[["employment","109K","118K","61K"]]],["adp","2026-06-03","08:15","ADP Private Employment","High",[["employment","122K","118K","105K"]]],["adp","2026-07-01","08:15","ADP Private Employment","High",[["employment","98K","118K","122K"]]],["adp","2026-08-05","08:15","ADP Private Employment","High",[["employment","44K","68K","95K"]]],["adp","2026-09-02","08:15","ADP Private Employment","High",[["employment","38K","47K","46K"]]],["confidence","2025-11-25","10:00","Consumer Confidence","High",[["confidence","88.7","93.5","95.5"]]],["confidence","2025-12-23","10:00","Consumer Confidence","High",[["confidence","89.1","91.7","92.9"]]],["confidence","2026-01-27","10:00","Consumer Confidence","High",[["confidence","84.5","90.6","94.2"]]],["confidence","2026-02-24","10:00","Consumer Confidence","High",[["confidence","91.2","87.4","89.0"]]],["confidence","2026-03-31","10:00","Consumer Confidence","High",[["confidence","91.8","87.8","91.0"]]],["confidence","2026-04-28","10:00","Consumer Confidence","High",[["confidence","92.8","89.0","92.2"]]],["confidence","2026-05-26","10:00","Consumer Confidence","High",[["confidence","93.1","91.9","93.8"]]],["confidence","2026-06-30","10:00","Consumer Confidence","High",[["confidence","91.2","94.4","90.6"]]],["confidence","2026-07-28","10:00","Consumer Confidence","High",[["confidence","90.8","92.4","92.2"]]],["confidence","2026-08-25","10:00","Consumer Confidence","High",[["confidence","89.4","90.3","90.2"]]],["durable","2026-01-26","08:30","Durable Goods Orders","High",[["headline","5.3%","3.1%","-2.1%"],["core","0.5%","0.3%","0.2%"]]],["durable","2026-02-18","08:30","Durable Goods Orders","High",[["headline","-1.4%","-1.8%","5.4%"],["core","0.9%","0.3%","0.4%"]]],["durable","2026-03-13","08:30","Durable Goods Orders","High",[["headline","0.0%","1.1%","-0.9%"],["core","0.4%","0.5%","1.3%"]]],["durable","2026-04-07","08:30","Durable Goods Orders","High",[["headline","-1.4%","-1.1%","-0.5%"],["core","0.8%","0.5%","0.3%"]]],["durable","2026-04-29","08:30","Durable Goods Orders","High",[["headline","0.8%","0.4%","-1.2%"],["core","0.9%","0.4%","1.2%"]]],["durable","2026-05-28","08:30","Durable Goods Orders","High",[["headline","7.9%","4.0%","1.3%"],["core","1.1%","0.5%","1.1%"]]],["durable","2026-06-25","08:30","Durable Goods Orders","High",[["headline","-4.5%","-5.0%","8.5%"],["core","1.3%","0.5%","1.4%"]]],["durable","2026-07-27","08:30","Durable Goods Orders","High",[["headline","0.3%","1.6%","-4.0%"],["core","0.6%","0.9%","1.8%"]]],["durable","2026-08-26","08:30","Durable Goods Orders","High",[["headline","1.1%","0.4%","0.3%"],["core","0.4%","0.6%","1.1%"]]],["retail","2026-01-14","08:30","Retail Sales","High",[["core","0.5%","0.4%","0.2%"],["headline","0.6%","0.5%","-0.1%"]]],["retail","2026-02-10","08:30","Retail Sales","High",[["core","0.0%","0.3%","0.4%"],["headline","0.0%","0.4%","0.6%"]]],["retail","2026-03-06","08:30","Retail Sales","High",[["core","0.0%","0.1%","0.0%"],["headline","-0.2%","-0.3%","0.0%"]]],["retail","2026-04-01","08:30","Retail Sales","High",[["core","0.5%","0.3%","0.0%"],["headline","0.6%","0.5%","-0.1%"]]],["retail","2026-04-21","08:30","Retail Sales","High",[["core","1.9%","1.4%","0.7%"],["headline","1.7%","1.4%","0.7%"]]],["retail","2026-05-14","08:30","Retail Sales","High",[["core","0.7%","0.7%","1.9%"],["headline","0.5%","0.5%","1.6%"]]],["retail","2026-06-17","08:30","Retail Sales","High",[["core","0.8%","0.6%","0.7%"],["headline","0.9%","0.5%","0.4%"]]],["retail","2026-07-16","08:30","Retail Sales","High",[["core","-0.2%","0.0%","1.0%"],["headline","0.2%","0.2%","1.0%"]]],["retail","2026-08-14","08:30","Retail Sales","High",[["core","-0.3%","0.2%","-0.2%"],["headline","-0.6%","0.1%","0.2%"]]],["retail","2026-09-16","08:30","Retail Sales","High",[["core","1.4%","0.6%","-0.2%"],["headline","1.2%","0.8%","-0.5%"]]],["gdp","2026-01-22","08:30","GDP QoQ","Very High",[["gdp_qoq","4.4%","4.3%","3.8%"]]],["gdp","2026-02-20","08:30","GDP QoQ","Very High",[["gdp_qoq","1.4%","2.8%","4.4%"]]],["gdp","2026-03-13","08:30","GDP QoQ","Very High",[["gdp_qoq","0.7%","1.4%","4.4%"]]],["gdp","2026-04-09","08:30","GDP QoQ","Very High",[["gdp_qoq","0.5%","0.7%","4.4%"]]],["gdp","2026-04-30","08:30","GDP QoQ","Very High",[["gdp_qoq","2.0%","2.2%","0.5%"]]],["gdp","2026-05-28","08:30","GDP QoQ","Very High",[["gdp_qoq","1.6%","2.0%","0.5%"]]],["gdp","2026-06-25","08:30","GDP QoQ","Very High",[["gdp_qoq","2.1%","1.6%","0.5%"]]],["gdp","2026-07-30","08:30","GDP QoQ","Very High",[["gdp_qoq","1.5%","2.1%","2.1%"]]],["gdp","2026-08-26","08:30","GDP QoQ","Very High",[["gdp_qoq","1.5%","1.5%","2.1%"]]],["ism-manufacturing","2026-02-02","10:00","ISM Manufacturing PMI","High",[["headline","52.6","48.5","47.9"],["prices","59.0","59.3","58.5"],["orders","57.1",null,"47.4"],["employment","48.1","46.0","44.8"]]],["ism-manufacturing","2026-03-02","10:00","ISM Manufacturing PMI","High",[["headline","52.4","51.7","52.6"],["prices","70.5","60.6","59.0"],["orders","55.8","53.3","57.1"],["employment","48.8","48.3","48.1"]]],["ism-manufacturing","2026-04-01","10:00","ISM Manufacturing PMI","High",[["headline","52.7","52.3","52.4"],["prices","78.3","74.0","70.5"],["orders","53.5","54.5","55.8"],["employment","48.7","49.0","48.8"]]],["ism-manufacturing","2026-05-01","10:00","ISM Manufacturing PMI","High",[["headline","52.7","53.1","52.7"],["prices","84.6","80.0","78.3"],["orders","54.1","54.5","53.5"],["employment","46.4","49.0","48.7"]]],["ism-manufacturing","2026-06-01","10:00","ISM Manufacturing PMI","High",[["headline","54.0","53.3","52.7"],["prices","82.1","85.3","84.6"],["orders","56.8","54.5","54.1"],["employment","48.6","48.2","46.4"]]],["ism-manufacturing","2026-07-01","10:00","ISM Manufacturing PMI","High",[["headline","53.3","53.8","54.0"],["prices","73.0","77.7","82.1"],["orders","56.0",null,"56.8"],["employment","49.7",null,"48.6"]]],["ism-manufacturing","2026-08-03","10:00","ISM Manufacturing PMI","High",[["headline","55.6","54.0","53.3"],["prices","71.1","70.0","73.0"],["orders","56.7","56.7","56.0"],["employment","52.8","50.0","49.7"]]],["ism-manufacturing","2026-09-01","10:00","ISM Manufacturing PMI","High",[["headline","54.6","55.2","55.6"],["prices","71.1","70.5","71.1"],["orders","53.7",null,"56.7"],["employment","51.2","52.5","52.8"]]],["ism-services","2026-01-07","10:00","ISM Services PMI","High",[["headline","54.4","52.2","52.6"],["prices","64.3","64.9","65.4"],["employment","52.0","49.0","48.9"]]],["ism-services","2026-02-04","10:00","ISM Services PMI","High",[["headline","53.8","53.5","53.8"],["prices","66.6","65.0","65.1"],["employment","50.3","52.3","51.7"]]],["ism-services","2026-03-04","10:00","ISM Services PMI","High",[["headline","56.1","53.5","53.8"],["prices","63.0","68.3","66.6"],["employment","51.8",null,"50.3"]]],["ism-services","2026-04-06","10:00","ISM Services PMI","High",[["headline","54.0","54.8","56.1"],["prices","70.7","67.0","63.0"],["employment","45.2","51.0","51.8"]]],["ism-services","2026-05-05","10:00","ISM Services PMI","High",[["headline","53.6","53.7","54.0"],["prices","70.7","73.7","70.7"],["employment","48.0","48.3","45.2"]]],["ism-services","2026-06-03","10:00","ISM Services PMI","High",[["headline","54.5","53.7","53.6"],["prices","71.3","72.3","70.7"],["employment","47.9","48.8","48.0"]]],["ism-services","2026-07-06","10:00","ISM Services PMI","High",[["headline","54.0","54.2","54.5"],["prices","67.7","67.5","71.3"],["employment","51.2","48.2","47.9"]]],["ism-services","2026-08-05","10:00","ISM Services PMI","High",[["headline","54.1","54.5","54.0"],["prices","70.3","65.0","67.7"],["employment","47.4","51.2","51.2"]]],["ism-services","2026-09-03","10:00","ISM Services PMI","High",[["headline","55.4","54.1","54.1"],["prices","72.6","70.0","70.3"],["employment","47.8","48.3","47.4"]]],["michigan","2026-06-26","10:00","Michigan Consumer Sentiment \u2014 Final","Medium",[["sentiment","49.5","48.9","44.8"],["expectations","50.7","49.3","44.1"],["conditions","47.7","48.4","45.8"],["infl1y","4.6%","4.6%","4.8%"],["infl5y","3.3%","3.4%","3.9%"]]],["michigan","2026-07-17","10:00","Michigan Consumer Sentiment \u2014 Preliminary","High",[["sentiment","54.4","51.0","49.5"],["expectations","54.0","51.7","50.7"],["conditions","54.9","48.7","47.7"],["infl1y","4.2%",null,"4.6%"],["infl5y","3.3%",null,"3.3%"]]],["michigan","2026-07-31","10:00","Michigan Consumer Sentiment \u2014 Final","Medium",[["sentiment","55.2","54.4","49.5"],["expectations","55.4","54.0","50.7"],["conditions","54.8","54.9","47.7"],["infl1y","4.2%","4.2%","4.6%"],["infl5y","3.3%","3.3%","3.3%"]]],["michigan","2026-08-14","10:00","Michigan Consumer Sentiment \u2014 Preliminary","High",[["sentiment","51.0","54.7","55.2"],["expectations","50.6","55.2","55.4"],["conditions","51.8","55.0","54.8"],["infl1y","4.3%",null,"4.2%"],["infl5y","3.3%",null,"3.3%"]]],["michigan","2026-08-28","10:00","Michigan Consumer Sentiment \u2014 Final","Medium",[["sentiment","51.7","51.0","55.2"],["expectations","51.5","50.6","55.4"],["conditions","51.9","51.8","54.8"],["infl1y","4.0%","4.3%","4.2%"],["infl5y","3.3%","3.3%","3.3%"]]],["michigan","2026-09-11","10:00","Michigan Consumer Sentiment \u2014 Preliminary","High",[["sentiment","47.8","51.0","51.7"],["expectations","45.8","50.5","51.5"],["conditions","50.9","51.3","51.9"],["infl1y","4.6%","4.2%","4.0%"],["infl5y","3.4%",null,null]]],["housing-starts","2026-02-18","08:30","Housing Starts","Medium",[["starts","1.404M","1.310M","1.272M"]]],["housing-starts","2026-03-12","08:30","Housing Starts","Medium",[["starts","1.487M","1.340M","1.387M"]]],["housing-starts","2026-04-29","08:30","Housing Starts","Medium",[["starts","1.502M","1.380M","1.398M"]]],["housing-starts","2026-05-21","08:30","Housing Starts","Medium",[["starts","1.465M","1.420M","1.507M"]]],["housing-starts","2026-06-16","08:30","Housing Starts","Medium",[["starts","1.177M","1.430M","1.392M"]]],["housing-starts","2026-07-17","08:30","Housing Starts","Medium",[["starts","1.427M","1.310M","1.199M"]]],["housing-starts","2026-08-18","08:30","Housing Starts","Medium",[["starts","1.239M","1.340M","1.415M"]]],["housing-starts","2026-09-17","08:30","Housing Starts","Medium",[["starts","1.275M","1.320M","1.309M"]]],["permits","2026-05-28","08:30","Building Permits","Medium",[["permits","4.4%","5.8%","-11.4%"]]],["permits","2026-06-24","08:30","Building Permits","Medium",[["permits","-0.9%","-0.7%","4.4%"]]],["permits","2026-07-24","08:30","Building Permits","Medium",[["permits","-2.6%","-3.0%","-0.9%"]]],["permits","2026-08-25","08:30","Building Permits","Medium",[["permits","4.3%","5.0%","-2.6%"]]],["eci","2024-04-30","08:30","Employment Cost Index","High",[["eci","1.2%","1.0%","0.9%"]]],["eci","2024-07-31","08:30","Employment Cost Index","High",[["eci","0.9%","1.0%","1.2%"]]],["eci","2024-10-31","08:30","Employment Cost Index","High",[["eci","0.8%","0.9%","0.9%"]]],["eci","2025-01-31","08:30","Employment Cost Index","High",[["eci","0.9%","0.9%","0.8%"]]],["eci","2025-04-30","08:30","Employment Cost Index","High",[["eci","0.9%","0.9%","0.9%"]]],["eci","2025-07-31","08:30","Employment Cost Index","High",[["eci","0.9%","0.8%","0.9%"]]],["eci","2025-12-10","08:30","Employment Cost Index","High",[["eci","0.8%","0.9%","0.9%"]]],["eci","2026-02-10","08:30","Employment Cost Index","High",[["eci","0.7%","0.8%","0.8%"]]],["eci","2026-04-30","08:30","Employment Cost Index","High",[["eci","0.9%","0.8%","0.7%"]]],["eci","2026-07-31","08:30","Employment Cost Index","High",[["eci","0.9%","0.8%","0.9%"]]],["claims","2026-07-30","08:30","Initial Jobless Claims","Medium",[["claims","197K","201K","188K"]]],["claims","2026-08-06","08:30","Initial Jobless Claims","Medium",[["claims","199K","203K","198K"]]],["claims","2026-08-13","08:30","Initial Jobless Claims","Medium",[["claims","209K","202K","200K"]]],["claims","2026-08-20","08:30","Initial Jobless Claims","Medium",[["claims","206K","210K","212K"]]],["claims","2026-08-27","08:30","Initial Jobless Claims","Medium",[["claims","203K","208K","207K"]]],["claims","2026-09-03","08:30","Initial Jobless Claims","Medium",[["claims","206K","205K","204K"]]],["claims","2026-09-10","08:30","Initial Jobless Claims","Medium",[["claims","206K","205K","207K"]]],["claims","2026-09-17","08:30","Initial Jobless Claims","Medium",[["claims","196K","207K","206K"]]],["fomc-decision","2026-01-28","14:00","FOMC Rate Decision","Extremely High",[]],["fed-presser","2026-01-28","14:30","Fed Press Conference","Extremely High",[]],["fomc-decision","2026-03-18","14:00","FOMC Rate Decision","Extremely High",[]],["fed-presser","2026-03-18","14:30","Fed Press Conference","Extremely High",[]],["fomc-decision","2026-04-29","14:00","FOMC Rate Decision","Extremely High",[]],["fed-presser","2026-04-29","14:30","Fed Press Conference","Extremely High",[]],["fomc-decision","2026-06-17","14:00","FOMC Rate Decision","Extremely High",[]],["fed-presser","2026-06-17","14:30","Fed Press Conference","Extremely High",[]],["fomc-decision","2026-07-29","14:00","FOMC Rate Decision","Extremely High",[]],["fed-presser","2026-07-29","14:30","Fed Press Conference","Extremely High",[]],["fomc-decision","2026-09-16","14:00","FOMC Rate Decision","Extremely High",[["rate","4.00%","4.00%","3.75%"]]],["fed-presser","2026-09-16","14:30","Fed Press Conference","Extremely High",[]],["fomc-minutes","2026-02-18","14:00","FOMC Minutes","High",[]],["fomc-minutes","2026-04-08","14:00","FOMC Minutes","High",[]],["fomc-minutes","2026-05-20","14:00","FOMC Minutes","High",[]],["fomc-minutes","2026-07-08","14:00","FOMC Minutes","High",[]],["fomc-minutes","2026-08-19","14:00","FOMC Minutes","High",[]]];
const HISTORICAL_CHAT_DATA = HISTORICAL_CHAT_ROWS.map((r,i)=>makeChatHistoryEvent({filterId:r[0],date:r[1],time_et:r[2],name:r[3],impact:r[4],metrics:r[5]},i));

const DEFAULT_IDS = FILTER_DEFS.map(x=>x.id);
const els = Object.fromEntries([
  'aiPrompt','applyAi','resetFilter','aiStatus','filterList','highOnly','showActual','exportIcs','prevMonth','todayBtn','nextMonth','refreshBtn',
  'monthTitle','eventCount','nextEventName','nextEventTime','filterMode','filterSummary','notice','calendarGrid','upcomingList','syncTime',
  'historyList','historyMore','coverageRange','coverageCount','eventDialog','dialogDate','dialogTitle','dialogBody','dialogSource'
].map(id=>[id,document.getElementById(id)]));

const now = new Date();
let state = {
  month:new Date(now.getFullYear(),now.getMonth(),1), allEvents:[], contextEvents:[], marketHeadlines:[],
  selected:new Set(JSON.parse(localStorage.getItem('macroSelected')||'null')||DEFAULT_IDS),
  highOnly:localStorage.getItem('macroHighOnly')==='true', showActual:localStorage.getItem('macroShowActual')!=='false',
  mode:localStorage.getItem('macroMode')||'ES/NQ', historyLimit:25, syncing:false, lastSync:0
};

function primarySource(filterId){return METRIC_SPECS[filterId]?.find(x=>x.primary)?.source || METRIC_SPECS[filterId]?.[0]?.source || SPECIAL_LINKS[filterId] || 'https://www.financecalendar.com/';}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function normalize(s=''){return String(s).toLowerCase().replace(/[^a-z0-9%]+/g,' ').replace(/\s+/g,' ').trim();}
function pad(n){return String(n).padStart(2,'0');}
function ymdLocal(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}

function archiveStartDate(){return new Date(`${ARCHIVE_START_DATE}T00:00:00-04:00`);}
function isArchiveEligible(ev){if(ev?.chatHistorical)return true;const d=parseEventDate(ev);return !!d && d.getTime()>=archiveStartDate().getTime();}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x;}
function monthLabel(d){return d.toLocaleDateString('en-US',{month:'long',year:'numeric'});}
function fmtDate(d){return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});}
function dateKeyET(d){const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const o=Object.fromEntries(p.map(x=>[x.type,x.value]));return `${o.year}-${o.month}-${o.day}`;}
function parseEventDate(ev){
  if(ev.time_utc){const d=new Date(ev.time_utc);return Number.isNaN(d.getTime())?null:d;}
  if(ev.datetime){const d=new Date(ev.datetime);return Number.isNaN(d.getTime())?null:d;}
  if(ev.date&&ev.time_et){const noon=new Date(`${ev.date}T12:00:00-04:00`);const tz=Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'longOffset'}).formatToParts(noon).find(x=>x.type==='timeZoneName')?.value||'GMT-04:00';const off=tz.replace('GMT','')||'-04:00';const d=new Date(`${ev.date}T${ev.time_et}:00${off}`);return Number.isNaN(d.getTime())?null:d;}
  if(ev.date){const d=new Date(`${ev.date}T12:00:00-04:00`);return Number.isNaN(d.getTime())?null:d;}
  return null;
}
function eventET(ev){if(ev.time_et){const [h,m]=String(ev.time_et).split(':').map(Number);return `${((h+11)%12)+1}:${pad(m||0)} ${h>=12?'PM':'AM'}`;}const d=parseEventDate(ev);return d?d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}):'—';}
function rawEventText(ev){return [ev.name,ev.title,ev.series,ev.category,ev.description].filter(Boolean).join(' ');}
function eventDateET(ev){const d=parseEventDate(ev);return d?dateKeyET(d):String(ev.date||'');}
function valueOrDash(v){return (v===null||v===undefined||v==='')?'—':String(v);}
function eventImpact(ev){const i=normalize(ev.impact);return i.includes('high')?'high':i.includes('medium')?'medium':'low';}
function isHighImpact(ev){const i=normalize(ev.impact);return i.includes('high');}

function isUnitedStatesEvent(ev){
  if(ev.canonical) return true;
  const country=String(ev.country||ev.country_name||ev.country_code||ev.iso_country||'').trim();
  if(country) return US_COUNTRY_RE.test(country);
  const currency=String(ev.currency||ev.ccy||'').trim().toUpperCase(); if(currency) return currency==='USD';
  const title=rawEventText(ev).trim(); if(FOREIGN_CENTRAL_BANK_RE.test(title)) return false;
  return US_TITLE_RE.test(title)||FED_CONTEXT_RE.test(title);
}
function matchesDef(ev,def){const t=rawEventText(ev);if(!isUnitedStatesEvent(ev))return false;if(def.requiresFed&&!FED_CONTEXT_RE.test(t))return false;return def.patterns.some(p=>p.test(t));}
function identifyFamily(ev){return FILTER_DEFS.find(def=>matchesDef(ev,def))?.id||null;}
function canonicalName(filterId,components=[]){
  if(filterId==='jobs')return 'NFP + Unemployment + Wages'; if(filterId==='pce')return 'PCE Inflation'; if(filterId==='cpi')return 'CPI'; if(filterId==='ppi')return 'PPI'; if(filterId==='retail')return 'Retail Sales'; if(filterId==='durable')return 'Durable Goods Orders';
  if(filterId==='michigan'){const txt=components.map(rawEventText).join(' ');if(/prelim/i.test(txt))return 'Michigan Consumer Sentiment — Preliminary';if(/final|revised/i.test(txt))return 'Michigan Consumer Sentiment — Final';}
  return FAMILY_META[filterId]?.label||'Economic Event';
}
function metricMatch(spec,c){const t=rawEventText(c);if(spec.exclude?.some(p=>p.test(t)))return false;return spec.patterns?.some(p=>p.test(t));}
function metricIdFor(filterId,c){return METRIC_SPECS[filterId]?.find(s=>metricMatch(s,c))?.id || normalize(c.name||c.title||'component');}
function scorePrimary(filterId,ev){const spec=METRIC_SPECS[filterId]?.find(s=>s.primary);return spec&&metricMatch(spec,ev)?100:0;}

function cleanContext(raw){
  const out=[]; const seen=new Set();
  for(const ev of raw){
    const family=identifyFamily(ev); const text=rawEventText(ev);
    const impact=normalize(ev.impact);
    const mediumOrHigh=impact.includes('medium')||impact.includes('high');
    const high=impact.includes('high');
    const us=isUnitedStatesEvent(ev);
    // Keep the main whitelist if it is a U.S. match. For related context, be broader:
    // material U.S. releases/Fed events, plus only clearly major global catalysts.
    if(!family){
      if(us){ if(!(mediumOrHigh || EXTRA_RELEVANCE_RE.test(text))) continue; }
      else { if(!(high && GLOBAL_CONTEXT_RE.test(text))) continue; }
    }
    const date=eventDateET(ev); if(!date)continue;
    const key=`${date}|${ev.time_et||ev.time_utc||''}|${normalize(ev.name||ev.title)}`; if(seen.has(key))continue; seen.add(key);
    out.push({id:`ctx-${key}`,date,time_et:ev.time_et,time_utc:ev.time_utc,name:ev.name||ev.title||'Relevant event',impact:ev.impact||'Medium',url:ev.url||'https://www.financecalendar.com/',filterId:family||null,approved:Boolean(family),country:us?'United States':(ev.country||ev.country_name||'Global')});
  }
  return out;
}

function groupFeedEvents(raw){
  const groups=new Map();
  for(const ev of raw){const filterId=identifyFamily(ev);if(!filterId)continue;const date=eventDateET(ev);if(!date)continue;const key=`${filterId}|${date}`;if(!groups.has(key))groups.set(key,{filterId,date,components:[]});groups.get(key).components.push(ev);}
  const out=[];
  for(const g of groups.values()){
    const comps=g.components.sort((a,b)=>scorePrimary(g.filterId,b)-scorePrimary(g.filterId,a)); const p=comps[0];
    out.push({id:`live-${g.filterId}-${g.date}`,filterId:g.filterId,date:g.date,time_utc:p.time_utc,time_et:p.time_et,name:canonicalName(g.filterId,comps),impact:FAMILY_META[g.filterId]?.impact||p.impact||'Medium',actual:p.actual,consensus:p.consensus??p.forecast,forecast:p.forecast??p.consensus,prior:p.prior??p.previous,previous:p.previous??p.prior,url:primarySource(g.filterId),country:'United States',currency:'USD',live:true,components:comps.map(c=>({name:c.name||c.title||canonicalName(g.filterId),title:c.title,actual:c.actual,forecast:c.forecast??c.consensus,consensus:c.consensus??c.forecast,previous:c.previous??c.prior,prior:c.prior??c.previous,originalPrevious:c.original_previous??c.previous_original??c.prior_original,url:c.url,time_utc:c.time_utc,time_et:c.time_et}))});
  }
  return out;
}
function occurrenceKey(ev){return `${ev.filterId}|${ev.date||eventDateET(ev)}`;}
function eventKey(ev){return String(ev.id||occurrenceKey(ev));}
function contextKey(ev){return `${ev.date}|${ev.time_et||ev.time_utc||''}|${normalize(ev.name)}`;}

function mergeComponents(filterId,oldList=[],newList=[]){
  const map=new Map();
  for(const c of oldList){map.set(metricIdFor(filterId,c),c);}
  for(const c of newList){
    const key=metricIdFor(filterId,c), old=map.get(key)||{}; const oldPrev=old.previous??old.prior, newPrev=c.previous??c.prior;
    const changed=oldPrev!==undefined&&oldPrev!==null&&oldPrev!==''&&newPrev!==undefined&&newPrev!==null&&newPrev!==''&&String(oldPrev)!==String(newPrev);
    map.set(key,{...old,...c,originalPrevious:c.originalPrevious??old.originalPrevious??(changed?oldPrev:undefined)});
  }
  return [...map.values()];
}
function mergeOccurrence(a,b){
  const live=b.live?b:(a.live?a:null), seed=a.canonical?a:(b.canonical?b:null); const oldPrev=a.previous??a.prior, newPrev=b.previous??b.prior; const changed=oldPrev!==undefined&&oldPrev!==null&&oldPrev!==''&&newPrev!==undefined&&newPrev!==null&&newPrev!==''&&String(oldPrev)!==String(newPrev);
  return {...(seed||a),...(live||b),id:`occ-${(live||b).filterId}-${(live||b).date}`,canonical:Boolean(seed),live:Boolean(live),sourceStatus:seed&&live?'Verified + live':live?'Live':'Verified fallback',url:primarySource((live||b).filterId),originalPrevious:b.originalPrevious??a.originalPrevious??(changed?oldPrev:undefined),components:mergeComponents((live||b).filterId,a.components||[],b.components||[])};
}
function mergeIntoState(events,context=[]){
  const map=new Map(state.allEvents.map(e=>[occurrenceKey(e),e]));for(const ev of events){const k=occurrenceKey(ev);map.set(k,map.has(k)?mergeOccurrence(map.get(k),ev):ev);}state.allEvents=[...map.values()].sort((a,b)=>(parseEventDate(a)?.getTime()||0)-(parseEventDate(b)?.getTime()||0));
  const cMap=new Map(state.contextEvents.map(e=>[contextKey(e),e]));for(const ev of context)cMap.set(contextKey(ev),{...(cMap.get(contextKey(ev))||{}),...ev});state.contextEvents=[...cMap.values()].sort((a,b)=>(parseEventDate(a)?.getTime()||0)-(parseEventDate(b)?.getTime()||0)); saveCache();
}
function matchesSelected(ev){if(!state.selected.has(ev.filterId))return false;if(state.highOnly&&!['high','very high','extremely high','medium high'].includes(normalize(ev.impact)))return false;return true;}
function filteredAll(){return state.allEvents.filter(matchesSelected).sort((a,b)=>(parseEventDate(a)?.getTime()||0)-(parseEventDate(b)?.getTime()||0));}
function monthEvents(){return filteredAll().filter(ev=>{const d=parseEventDate(ev);return d&&d.getFullYear()===state.month.getFullYear()&&d.getMonth()===state.month.getMonth();});}

function renderFilters(){els.filterList.innerHTML=FILTER_DEFS.map(def=>`<label class="filter-item"><input type="checkbox" data-id="${def.id}" ${state.selected.has(def.id)?'checked':''}/><span>${esc(def.label)}</span></label>`).join('');els.filterList.querySelectorAll('input').forEach(input=>input.addEventListener('change',e=>{const id=e.target.dataset.id;e.target.checked?state.selected.add(id):state.selected.delete(id);persist();renderAll();}));els.highOnly.checked=state.highOnly;els.showActual.checked=state.showActual;}
function persist(){localStorage.setItem('macroSelected',JSON.stringify([...state.selected]));localStorage.setItem('macroHighOnly',String(state.highOnly));localStorage.setItem('macroShowActual',String(state.showActual));localStorage.setItem('macroMode',state.mode);}
function saveCache(){try{localStorage.setItem(CACHE_KEY,JSON.stringify({savedAt:Date.now(),events:state.allEvents,contextEvents:state.contextEvents,lastSync:state.lastSync}));}catch(_){}}
function loadCache(){try{const c=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');if(c&&Array.isArray(c.events)){state.allEvents=c.events.filter(isArchiveEligible);state.contextEvents=(Array.isArray(c.contextEvents)?c.contextEvents:[]).filter(x=>{const d=parseEventDate(x);return d&&d.getTime()>=archiveStartDate().getTime();});state.lastSync=Number(c.lastSync||c.savedAt||0);}}catch(_){}mergeIntoState(HISTORICAL_CHAT_DATA);mergeIntoState(CANONICAL_SEED.filter(isArchiveEligible));}

async function loadSharedData(){
  try{
    const [feedRes,headlineRes]=await Promise.all([
      fetch('./data/shared-feed.json',{cache:'no-store'}),
      fetch('./data/market-headlines.json',{cache:'no-store'})
    ]);
    if(feedRes.ok){
      const payload=await feedRes.json();
      const raw=Array.isArray(payload)?payload:(payload.events||payload.data||[]);
      const grouped=groupFeedEvents(raw).filter(isArchiveEligible);
      const context=cleanContext(raw).filter(x=>{const d=parseEventDate(x);return d&&d.getTime()>=archiveStartDate().getTime();});
      mergeIntoState(grouped,context);
    }
    if(headlineRes.ok){
      const payload=await headlineRes.json();
      state.marketHeadlines=Array.isArray(payload)?payload:(payload.articles||[]);
    }
  }catch(_){ /* static/local copies still work without the shared JSON */ }
}

async function fetchRange(from,to){const url=`${API_BASE}/calendar?from=${ymdLocal(from)}&to=${ymdLocal(to)}&limit=500`;const res=await fetch(url,{headers:{Accept:'application/json'}});if(!res.ok)throw new Error(`Calendar API returned ${res.status}`);const data=await res.json();const raw=Array.isArray(data)?data:(data.events||data.calendar||data.data||[]);return {events:groupFeedEvents(raw),context:cleanContext(raw)};}
async function syncRange(from,to){const result=await fetchRange(from,to);result.events=(result.events||[]).filter(isArchiveEligible);result.context=(result.context||[]).filter(x=>{const d=parseEventDate(x);return d&&d.getTime()>=archiveStartDate().getTime();});mergeIntoState(result.events,result.context);return result;}
async function syncVisibleMonth(){let from=new Date(state.month.getFullYear(),state.month.getMonth(),1),to=new Date(state.month.getFullYear(),state.month.getMonth()+1,0);const start=archiveStartDate();if(to.getTime()<start.getTime()){renderAll();return;}if(from.getTime()<start.getTime())from=start;try{await syncRange(from,to);}catch(err){showNotice(`Live sync for ${monthLabel(state.month)} is unavailable: ${err.message}. Cached/verified dates are still shown.`);}renderAll();}
function showNotice(text){els.notice.textContent=text;els.notice.classList.remove('hidden');}function hideNotice(){els.notice.classList.add('hidden');}
async function scanFuture(){
  let cursor=new Date(), emptyWindows=0, windows=0;
  while(emptyWindows<EMPTY_WINDOWS_TO_STOP && windows<SCAN_SAFETY_WINDOWS){
    const from=new Date(cursor),to=addDays(from,RANGE_DAYS-1);cursor=addDays(to,1);
    try{
      const result=await syncRange(from,to);
      const found=(result.events?.length||0)+(result.context?.length||0);
      emptyWindows=found?0:emptyWindows+1;
    }catch(err){if(windows===0)throw err;break;}
    windows++;renderCoverage();renderUpcoming();renderHistory();
  }
}
async function syncCatchup(){
  const now=new Date(), start=archiveStartDate();
  let from;
  if(state.lastSync){from=addDays(new Date(state.lastSync),-7);}else{from=addDays(now,-CATCHUP_DAYS_WITHOUT_CACHE);}
  if(from.getTime()<start.getTime())from=start;
  let cursor=new Date(from), windows=0;
  while(cursor.getTime()<=now.getTime() && windows<SCAN_SAFETY_WINDOWS){
    const to=new Date(Math.min(addDays(cursor,RANGE_DAYS-1).getTime(),now.getTime()));
    await syncRange(cursor,to);cursor=addDays(to,1);windows++;
  }
}
async function syncCoverage({force=false,quiet=false}={}){if(state.syncing)return;if(!force&&state.lastSync&&Date.now()-state.lastSync<CACHE_TTL_MS){renderAll();return;}state.syncing=true;els.refreshBtn.disabled=true;els.refreshBtn.textContent='Searching…';hideNotice();if(!quiet)els.syncTime.textContent='Catching up archive and scanning published future dates…';try{await syncCatchup();await scanFuture();state.lastSync=Date.now();saveCache();els.syncTime.textContent=`Auto-synced ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;}catch(err){showNotice(`Live schedule search is unavailable right now: ${err.message}. Cached and verified dates remain usable.`);}finally{state.syncing=false;els.refreshBtn.disabled=false;els.refreshBtn.textContent='Sync all dates';renderAll();}}

function renderCalendar(){els.monthTitle.textContent=monthLabel(state.month);const first=new Date(state.month.getFullYear(),state.month.getMonth(),1),gridStart=new Date(first);gridStart.setDate(1-first.getDay());const byDay=new Map();for(const ev of monthEvents()){const d=parseEventDate(ev);if(!d)continue;const key=dateKeyET(d);if(!byDay.has(key))byDay.set(key,[]);byDay.get(key).push(ev);}const todayKey=dateKeyET(new Date());let html='';for(let i=0;i<42;i++){const d=new Date(gridStart);d.setDate(gridStart.getDate()+i);const key=ymdLocal(d),outside=d.getMonth()!==state.month.getMonth(),list=byDay.get(key)||[];html+=`<div class="day-cell ${outside?'outside':''} ${key===todayKey?'today':''}"><div class="day-number">${d.getDate()}</div>${list.slice(0,3).map(ev=>`<button class="event-chip ${eventImpact(ev)}" data-event-id="${esc(eventKey(ev))}"><span class="event-time">${esc(eventET(ev))}</span>${esc(ev.name||'Economic event')}</button>`).join('')}${list.length>3?`<div class="more-chip">+${list.length-3} more</div>`:''}</div>`;}els.calendarGrid.innerHTML=html;els.calendarGrid.querySelectorAll('[data-event-id]').forEach(btn=>btn.addEventListener('click',()=>openEvent(btn.dataset.eventId)));}
function renderSummary(){const monthList=monthEvents();els.eventCount.textContent=monthList.length;const nowMs=Date.now(),next=filteredAll().find(ev=>(parseEventDate(ev)?.getTime()||0)>=nowMs);els.nextEventName.textContent=next?(next.name||'Event'):'—';els.nextEventTime.textContent=next?`${fmtDate(parseEventDate(next))} · ${eventET(next)} ET`:'No published next event';els.filterMode.textContent=state.mode;els.filterSummary.textContent=`${state.selected.size} event families selected${state.highOnly?' · high impact only':''}`;renderCoverage();}
function renderCoverage(){const list=filteredAll();if(!list.length){els.coverageRange.textContent='—';els.coverageCount.textContent='No dates loaded';return;}const first=parseEventDate(list[0]),last=parseEventDate(list[list.length-1]);els.coverageRange.textContent=`${first.toLocaleDateString('en-US',{month:'short',year:'numeric'})} → ${last.toLocaleDateString('en-US',{month:'short',year:'numeric'})}`;els.coverageCount.textContent=`${list.length} occurrences · built-in history + shared live archive`;}
function renderUpcoming(){const nowMs=Date.now()-60*60*1000,list=filteredAll().filter(ev=>(parseEventDate(ev)?.getTime()||0)>=nowMs).slice(0,20);els.upcomingList.innerHTML=list.length?list.map(rowHtml).join(''):'<div class="empty-state">No upcoming matching events have been published yet.</div>';}
function renderHistory(){const all=filteredAll().filter(ev=>isArchiveEligible(ev)&&(parseEventDate(ev)?.getTime()||0)<Date.now()).reverse(),list=all.slice(0,state.historyLimit);els.historyList.innerHTML=list.length?list.map(rowHtml).join(''):`<div class="empty-state">No previous occurrences loaded for the selected filters.</div>`;els.historyMore.classList.toggle('hidden',all.length<=state.historyLimit);if(all.length>state.historyLimit)els.historyMore.textContent=`Show ${Math.min(25,all.length-state.historyLimit)} more`;}
function rowHtml(ev){const d=parseEventDate(ev),rows=buildMetricRows(ev),primary=rows.find(r=>r.primary)||rows[0];const actual=primary?.actual??ev.actual,forecast=primary?.forecast??ev.forecast??ev.consensus,previous=primary?.previous??ev.previous??ev.prior;const future=(parseEventDate(ev)?.getTime()||0)>Date.now();const hasAny=[actual,forecast,previous].some(v=>v!==null&&v!==undefined&&v!=='')||future;const actualText=future&&(actual===null||actual===undefined||actual==='')?'Pending':valueOrDash(actual);const forecastText=future&&(forecast===null||forecast===undefined||forecast==='')?'Not yet published':valueOrDash(forecast);const vals=state.showActual&&hasAny?`Actual ${esc(actualText)} · Forecast ${esc(forecastText)} · Previous ${esc(valueOrDash(previous))}`:'';return `<button class="upcoming-row row-button" data-open-event="${esc(eventKey(ev))}"><div class="upcoming-date">${esc(fmtDate(d))}<br><span class="muted">${esc(eventET(ev))} ET</span></div><div><div class="upcoming-name">${esc(ev.name||'Economic event')}</div>${vals?`<div class="upcoming-values">${vals}</div>`:''}<div class="source-status">${esc(ev.sourceStatus||(ev.live?'Live':'Verified'))}</div></div><span class="impact-badge ${eventImpact(ev)}">${esc(ev.impact||'event')}</span></button>`;}
function wireRowButtons(){document.querySelectorAll('[data-open-event]').forEach(btn=>btn.addEventListener('click',()=>openEvent(btn.dataset.openEvent)));}
function renderAll(){renderCalendar();renderSummary();renderUpcoming();renderHistory();wireRowButtons();}

function findComponent(ev,spec){return (ev.components||[]).find(c=>metricMatch(spec,c));}
function parseNumberWithUnit(v){if(v===null||v===undefined||v==='')return null;const s=String(v).replace(/,/g,'').trim();const m=s.match(/([+-]?\d+(?:\.\d+)?)\s*(%|[KMB])?/i);if(!m)return null;return {n:Number(m[1]),unit:(m[2]||'').toUpperCase()};}
function surpriseValue(actual,forecast){const a=parseNumberWithUnit(actual),f=parseNumberWithUnit(forecast);if(!a||!f)return '—';let an=a.n,fn=f.n,unit=a.unit||f.unit;if(a.unit!==f.unit&&a.unit&&f.unit)return '—';let diff=an-fn;if(unit==='%')return `${diff>0?'+':''}${trimNum(diff)} pp`;if(unit==='M'&&Math.abs(diff)<1)return `${diff>0?'+':''}${trimNum(diff*1000)}K`;return `${diff>0?'+':''}${trimNum(diff)}${unit}`;}
function trimNum(n){return Number(n.toFixed(Math.abs(n)<1?3:2)).toString();}
function extractSummaryValue(text,spec){
  if(!text||!spec.summary)return null;const s=String(text);const period=spec.summary.period==='mom'?'(?:MoM|M\/M|month(?:ly)?|month-on-month)':'(?:YoY|Y\/Y|year(?:ly)?|year-on-year)';const prefix=spec.summary.prefix==='core'?'core':'(?:headline|overall)?';
  const re1=new RegExp(`${prefix}[^;,.]{0,35}?([+-]?\\d+(?:\\.\\d+)?)%?\\s*${period}`,'i');const m1=s.match(re1);if(m1)return `${m1[1]}%`;
  // Sometimes period comes before the value.
  const re2=new RegExp(`${prefix}[^;,.]{0,20}?${period}[^;,.]{0,15}?([+-]?\\d+(?:\\.\\d+)?)%?`,'i');const m2=s.match(re2);return m2?`${m2[1]}%`:null;
}
function latestPriorOccurrence(ev){
  const t=parseEventDate(ev)?.getTime()||0;
  return state.allEvents
    .filter(x=>x.filterId===ev.filterId && (parseEventDate(x)?.getTime()||0)<t)
    .sort((a,b)=>(parseEventDate(b)?.getTime()||0)-(parseEventDate(a)?.getTime()||0))[0]||null;
}
function actualForSpec(occ,spec){
  if(!occ||!spec)return null;
  const specs=METRIC_SPECS[occ.filterId]||[];
  const c=findComponent(occ,spec);
  const useTop=!c&&specs.length===1;
  return c?.actual??(useTop?occ.actual:null)??extractSummaryValue(occ.actual,spec);
}
function buildMetricRows(ev){
  const specs=METRIC_SPECS[ev.filterId]||[]; if(!specs.length)return [];
  const singleMetric=specs.length===1;
  const priorOcc=latestPriorOccurrence(ev);
  const isFuture=(parseEventDate(ev)?.getTime()||0)>Date.now();
  return specs.map((spec,idx)=>{
    const c=findComponent(ev,spec);
    // Never push a generic family-level number into a specific Core/Headline/MoM/YoY row.
    // Top-level fallback is safe only for true one-metric reports.
    const useTop=!c&&singleMetric;
    const actual=c?.actual??(useTop?ev.actual:null);
    const forecast=c?.forecast??c?.consensus??(useTop?(ev.forecast??ev.consensus):null);
    const previous=c?.previous??c?.prior??(useTop?(ev.previous??ev.prior):null);
    const actual2=actual??extractSummaryValue(ev.actual,spec);
    const forecast2=forecast??extractSummaryValue(ev.forecast??ev.consensus,spec);
    let previous2=previous??extractSummaryValue(ev.previous??ev.prior,spec);
    let previousFallback=false;
    if(isFuture && (previous2===null||previous2===undefined||previous2==='')){
      const lastActual=actualForSpec(priorOcc,spec);
      if(lastActual!==null&&lastActual!==undefined&&lastActual!==''){
        previous2=lastActual;
        previousFallback=true;
      }
    }
    const original=c?.originalPrevious??(useTop?ev.originalPrevious:null);
    return {id:spec.id,label:spec.label,source:spec.source,official:spec.official,primary:Boolean(spec.primary),noForecast:Boolean(spec.noForecast),actual:actual2,forecast:spec.noForecast?null:forecast2,previous:previous2,previousFallback,originalPrevious:original,surprise:spec.noForecast?'—':surpriseValue(actual2,forecast2)};
  });
}
function detailMetricRows(ev){
  const rows=buildMetricRows(ev);
  if(!['housing-starts','permits'].includes(ev.filterId)) return rows;
  const otherId=ev.filterId==='housing-starts'?'permits':'housing-starts';
  const other=state.allEvents.find(x=>x.filterId===otherId&&eventDateET(x)===eventDateET(ev)&&eventET(x)===eventET(ev));
  const combined=other?[...rows,...buildMetricRows(other)]:rows;
  const order=['starts','permits'];
  return combined.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
}
function revisionHtml(row){if(row.originalPrevious===null||row.originalPrevious===undefined||row.originalPrevious===''||String(row.originalPrevious)===String(row.previous))return '';return `<span class="revision-note">was ${esc(row.originalPrevious)}</span>`;}
function metricTableHtml(rows,ev){if(!rows.length)return '';const future=(parseEventDate(ev)?.getTime()||0)>Date.now();return `<div class="detail-section"><div class="detail-section-title">Report data</div><div class="metric-table"><div class="metric-head"><span>Metric</span><span>Previous</span><span>Forecast</span><span>Actual</span><span>Surprise</span><span>Sources</span></div>${rows.map(r=>`<div class="metric-row"><span class="metric-name">${esc(r.label)}</span><span>${esc(valueOrDash(r.previous))}${r.previousFallback?'<span class="revision-note">latest stored actual</span>':''}${revisionHtml(r)}</span><span>${r.noForecast?'<span class="muted">N/A</span>':(future&&(r.forecast===null||r.forecast===undefined||r.forecast==='')?'<span class="muted">Not yet published</span>':esc(valueOrDash(r.forecast)))}</span><span>${future&&(r.actual===null||r.actual===undefined||r.actual==='')?'<span class="muted">Pending</span>':esc(valueOrDash(r.actual))}</span><span class="surprise-cell">${esc(r.surprise)}</span><span class="source-links">${r.source?`<a class="metric-link" href="${esc(r.source)}" target="_blank" rel="noreferrer">Investing</a>`:''}${r.official?`<a class="metric-link official-link" href="${esc(r.official)}" target="_blank" rel="noreferrer">Official</a>`:''}</span></div>`).join('')}</div></div>`;}
function reportLevelHtml(ev,rows){const multi=(METRIC_SPECS[ev.filterId]||[]).length>1;if(!multi||ev.chatHistorical)return '';const actual=ev.actual,forecast=ev.forecast??ev.consensus;const primary=rows.find(r=>r.primary)||rows[0];const previous=ev.previous??ev.prior??primary?.previous;const isFuture=(parseEventDate(ev)?.getTime()||0)>Date.now();const hasAny=[actual,forecast,previous].some(v=>v!==null&&v!==undefined&&v!=='')||isFuture;if(!hasAny)return '';const feedSpecificHasAny=rows.some(r=>[r.actual,r.forecast].some(v=>v!==null&&v!==undefined&&v!==''));if(feedSpecificHasAny)return '';return `<div class="detail-section report-level"><div class="detail-section-title">Report-level calendar data</div><div class="report-level-grid"><div><span>Previous</span><strong>${esc(valueOrDash(previous))}</strong></div><div><span>Forecast</span><strong>${isFuture&&(forecast===null||forecast===undefined||forecast==='')?'Not yet published':esc(valueOrDash(forecast))}</strong></div><div><span>Actual</span><strong>${isFuture&&(actual===null||actual===undefined||actual==='')?'Pending':esc(valueOrDash(actual))}</strong></div></div><div class="context-footnote">Previous falls back to MacroCal’s latest stored actual when the live calendar does not provide it. Forecast stays blank until FinanceCalendar publishes a real consensus; MacroCal does not invent estimates.</div></div>`;}
function contextDayDiff(baseDate,otherDate){
  const a=new Date(`${baseDate}T12:00:00Z`),b=new Date(`${otherDate}T12:00:00Z`);
  if(Number.isNaN(a.getTime())||Number.isNaN(b.getTime()))return 99;
  return Math.round((b-a)/86400000);
}
function relevantContextFor(ev){
  const d=eventDateET(ev),t=eventET(ev),selfKey=eventKey(ev); const scheduled=[]; const headlines=[]; const seen=new Set();
  const addScheduled=(x,{outsideWhitelist=false}={})=>{
    if(eventKey(x)===selfKey)return;
    const xd=eventDateET(x)||x.date;if(!xd)return;
    const diff=contextDayDiff(d,xd);if(Math.abs(diff)>1)return;
    const impact=normalize(x.impact||'');
    const major=isHighImpact(x)||impact.includes('medium')||GLOBAL_CONTEXT_RE.test(x.name||'')||EXTRA_RELEVANCE_RE.test(x.name||'');
    if(!major)return;
    const time=eventET(x),name=x.name||x.title||'Relevant event';
    const k=normalize(`${xd}|${time}|${name}`);if(seen.has(k))return;seen.add(k);
    let tag='Same day';
    if(diff===0&&time===t)tag='Same time'; else if(diff<0)tag='Previous day'; else if(diff>0)tag='Next day';
    scheduled.push({name,time,impact:x.impact,url:outsideWhitelist?(x.url||'https://www.financecalendar.com/'):primarySource(x.filterId),country:x.country||'United States',tag,diff});
  };
  // Approved MacroCal releases within one day of the selected event.
  for(const x of state.allEvents)addScheduled(x);
  // Broader scheduled context from the shared feed: Fed speakers, secondary U.S. data,
  // Treasury events, and major global central-bank/data catalysts.
  for(const x of state.contextEvents)addScheduled(x,{outsideWhitelist:true});
  scheduled.sort((a,b)=>Math.abs(a.diff)-Math.abs(b.diff)||String(a.time).localeCompare(String(b.time)));
  // Stored headlines are retrospective by design: they appear only after a headline has actually
  // reported a market move on the selected date. We do not fabricate future headline context.
  for(const h of state.marketHeadlines||[]){
    if(h.date_et!==d || !h.effect_reported) continue;
    const k=normalize(h.url||h.title); if(seen.has(k))continue; seen.add(k);
    headlines.push({name:h.title,time:h.time_et||'',url:h.url,source:h.domain||h.source||'News',tag:'Market move',headline:true});
    if(headlines.length>=6)break;
  }
  return {scheduled:scheduled.slice(0,12),headlines};
}

function contextHtml(ev){
  const {scheduled,headlines}=relevantContextFor(ev);
  const items=[...scheduled,...headlines];
  const future=(parseEventDate(ev)?.getTime()||0)>Date.now();
  if(!items.length)return `<div class="detail-section compact-context"><div class="detail-section-title">Other relevant market events</div><div class="context-empty">No other major scheduled catalysts are currently published within one day of this event.${future?' Market-impact headlines will be added after the date occurs and a headline explicitly reports a market move.':''}</div></div>`;
  return `<div class="detail-section compact-context"><div class="detail-section-title">Other relevant market events</div><div class="context-list">${items.map(x=>`<a class="context-item" href="${esc(x.url||'#')}" target="_blank" rel="noreferrer"><span class="context-tag">${esc(x.tag)}</span><span>${x.headline?`${x.time?`${esc(x.time)} ET · `:''}${esc(x.name)}${x.source?` <span class="context-source">· ${esc(x.source)}</span>`:''}`:`${esc(x.time)} ET · ${esc(x.name)}`}</span></a>`).join('')}</div><div class="context-footnote">Scheduled context covers major catalysts from the previous day through the next day. “Market move” is retrospective and means the saved headline itself explicitly reported a move in stocks, Nasdaq/S&amp;P, futures, Treasury yields, or the dollar; it is not an automated claim that the headline was the sole cause.</div></div>`;
}

function previousFomcDecision(ev){
  const t=parseEventDate(ev)?.getTime()||0;
  return state.allEvents.filter(x=>x.filterId==='fomc-decision'&&(parseEventDate(x)?.getTime()||0)<t).sort((a,b)=>(parseEventDate(b)?.getTime()||0)-(parseEventDate(a)?.getTime()||0))[0]||null;
}
function fomcMinutesUrl(ev){
  const meeting=previousFomcDecision(ev); if(!meeting)return SPECIAL_LINKS['fomc-minutes'];
  const d=parseEventDate(meeting); if(!d)return SPECIAL_LINKS['fomc-minutes'];
  const y=d.toLocaleDateString('en-CA',{timeZone:'America/New_York',year:'numeric'});
  const m=d.toLocaleDateString('en-CA',{timeZone:'America/New_York',month:'2-digit'});
  const day=d.toLocaleDateString('en-CA',{timeZone:'America/New_York',day:'2-digit'});
  return `https://www.federalreserve.gov/monetarypolicy/files/fomcminutes${y}${m}${day}.pdf`;
}
function specialEventHtml(ev){
  if(ev.filterId==='fomc-minutes'){
    const meeting=previousFomcDecision(ev);const label=meeting?`${fmtDate(parseEventDate(meeting))} meeting decision`:'prior FOMC meeting';
    return `<div class="special-note"><strong>FOMC Minutes</strong><span>Minutes for the ${esc(label)}. No Previous / Forecast / Actual number; use the minutes plus US02Y and NQ/ES reaction.</span></div>`;
  }
  if(ev.filterId==='fed-presser')return `<div class="special-note"><strong>Fed Press Conference</strong><span>No numeric release. Follow the live Fed broadcast together with US02Y and NQ/ES.</span></div>`;return '';
}
function openEvent(id){const ev=state.allEvents.find(e=>eventKey(e)===id);if(!ev)return;const d=parseEventDate(ev),rows=detailMetricRows(ev);els.dialogDate.textContent=`${fmtDate(d)} · ${eventET(ev)} ET`;els.dialogTitle.textContent=['housing-starts','permits'].includes(ev.filterId)?'Housing Starts + Building Permits':(ev.name||'Economic event');els.dialogBody.innerHTML=`<div class="event-meta-strip"><span>${esc(ev.impact||'—')} impact</span><span>${esc(ev.sourceStatus||'Live')}</span></div>${specialEventHtml(ev)}${reportLevelHtml(ev,rows)}${metricTableHtml(rows,ev)}${contextHtml(ev)}${['fomc-minutes','fed-presser'].includes(ev.filterId)?`<div class="detail-section"><div class="detail-section-title">Sources</div><div class="special-source-links"><a class="metric-link" href="${esc(SPECIAL_INVESTING_LINKS[ev.filterId])}" target="_blank" rel="noreferrer">Investing.com</a><a class="metric-link official-link" href="${esc(ev.filterId==='fomc-minutes'?fomcMinutesUrl(ev):SPECIAL_LINKS[ev.filterId])}" target="_blank" rel="noreferrer">Official Federal Reserve</a></div></div>`:''}<div class="data-note"><strong>Source policy:</strong> ${ev.chatHistorical?'older historical values shown here are the verified values collected in this ChatGPT conversation;':'automated fields are merged from the shared machine-readable calendar archive when available;'} every metric also includes the approved Investing.com page and the official primary-source release for verification. Missing values are left blank rather than guessed.</div>`;els.dialogSource.href=ev.filterId==='fomc-minutes'?fomcMinutesUrl(ev):primarySource(ev.filterId);els.dialogSource.textContent=ev.filterId==='fed-presser'?'Fed live video':ev.filterId==='fomc-minutes'?'Specific Fed minutes PDF':'Investing.com';els.eventDialog.showModal();}

function localPromptToSelection(prompt){const p=normalize(prompt),selected=new Set();FILTER_DEFS.forEach(def=>{if(def.terms.some(t=>p.includes(normalize(t)))||p.includes(normalize(def.label)))selected.add(def.id);});if(/major.*es nq|es nq.*major|all.*macro|my es nq list/.test(p))DEFAULT_IDS.forEach(x=>selected.add(x));if(p.includes('inflation only'))['cpi','ppi','pce'].forEach(x=>selected.add(x));if(p.includes('labor only')||p.includes('jobs only'))['jolts','adp','jobs','claims','eci'].forEach(x=>selected.add(x));if(p.includes('fed only'))['fomc-decision','fomc-minutes','fed-presser'].forEach(x=>selected.add(x));return selected.size?selected:new Set(DEFAULT_IDS);}
async function applyAiFilter(){const prompt=els.aiPrompt.value.trim();if(!prompt)return;els.applyAi.disabled=true;els.applyAi.textContent='Thinking…';try{const res=await fetch('/api/filter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,filters:FILTER_DEFS.map(({id,label})=>({id,label}))})});if(!res.ok)throw new Error('AI endpoint not configured');const data=await res.json(),ids=(data.selected||[]).filter(id=>FILTER_DEFS.some(d=>d.id===id));if(!ids.length)throw new Error('AI returned no matches');state.selected=new Set(ids);state.highOnly=Boolean(data.highOnly);state.mode='AI';els.aiStatus.textContent=`AI selected ${ids.length} event families.`;}catch(_){state.selected=localPromptToSelection(prompt);state.mode='Smart local';els.aiStatus.textContent='Using local smart matching. Deploy the included Cloudflare AI function for true natural-language AI filtering.';}finally{persist();renderFilters();renderAll();els.applyAi.disabled=false;els.applyAi.textContent='Apply AI filter';}}
function exportIcs(){const events=filteredAll(),lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//MacroCal//ESNQ Calendar//EN','CALSCALE:GREGORIAN'];for(const ev of events){const d=parseEventDate(ev);if(!d)continue;const dt=d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),end=new Date(d.getTime()+30*60000).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');lines.push('BEGIN:VEVENT',`UID:${btoa(unescape(encodeURIComponent(eventKey(ev)))).replace(/=/g,'')}@macrocal`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}`,`DTSTART:${dt}`,`DTEND:${end}`,`SUMMARY:${String(ev.name||'Economic event').replace(/,/g,'\\,')}`,'END:VEVENT');}lines.push('END:VCALENDAR');const blob=new Blob([lines.join('\r\n')],{type:'text/calendar'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='esnq-macro-all-published.ics';a.click();URL.revokeObjectURL(a.href);}

els.applyAi.addEventListener('click',applyAiFilter);
els.resetFilter.addEventListener('click',()=>{state.selected=new Set(DEFAULT_IDS);state.highOnly=false;state.mode='ES/NQ';persist();renderFilters();renderAll();els.aiStatus.textContent='Reset to your full ES/NQ macro list.';});
els.highOnly.addEventListener('change',e=>{state.highOnly=e.target.checked;persist();renderAll();});els.showActual.addEventListener('change',e=>{state.showActual=e.target.checked;persist();renderAll();});
els.prevMonth.addEventListener('click',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()-1,1);syncVisibleMonth();});els.nextMonth.addEventListener('click',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()+1,1);syncVisibleMonth();});els.todayBtn.addEventListener('click',()=>{const n=new Date();state.month=new Date(n.getFullYear(),n.getMonth(),1);syncVisibleMonth();});els.refreshBtn.addEventListener('click',()=>syncCoverage({force:true}));els.exportIcs.addEventListener('click',exportIcs);els.historyMore.addEventListener('click',()=>{state.historyLimit+=25;renderHistory();wireRowButtons();});

loadCache();renderFilters();renderAll();loadSharedData().finally(()=>{renderAll();syncVisibleMonth().then(()=>syncCoverage({force:false}));});setInterval(()=>{loadSharedData().finally(()=>syncCoverage({force:true,quiet:true}));},CACHE_TTL_MS);
