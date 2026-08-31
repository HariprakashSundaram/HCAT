const $ = (id) => document.getElementById(id);
let sessionId = null;
let rows = [];
let steps = [];
let selectedStep = 0;
let groups = [];
let domains = new Map();
let types = new Map();
let recording = false;
let paused = false;

async function msg(type, extra={}) {
  return chrome.runtime.sendMessage({type, ...extra});
}

// XML 1.0 does not allow most control characters (for example U+001F).
// Chrome can capture such characters in request bodies or headers, so strip them
// before placing captured data inside a JMeter .jmx file.
function xmlSafeText(value) {
  const s = String(value ?? "");
  let out = "";
  // Keep only characters that are safe for JMeter/Xerces XML parsing.
  // In practice, stripping C0/C1 controls is safest for captured HTTP data.
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xFFFF) i++;
    const allowed =
      cp === 0x09 || cp === 0x0A || cp === 0x0D ||
      (cp >= 0x20 && cp <= 0x7E) ||
      (cp >= 0xA0 && cp <= 0xD7FF) ||
      (cp >= 0xE000 && cp <= 0xFFFD) ||
      (cp >= 0x10000 && cp <= 0x10FFFF);
    if (allowed) out += String.fromCodePoint(cp);
  }
  return out;
}

function escapeXml(s) {
  return xmlSafeText(s)
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&apos;");
}
function escapeHtml(s){
  return String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function setMessage(text, kind="") {
  $("message").textContent = text;
  $("message").className = `message ${kind}`;
}
function displayPath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (u.pathname || "/") + (u.search || "");
  } catch (_) { return rawUrl || "/"; }
}
function getDomain(rawUrl) {
  try { return new URL(rawUrl).hostname; } catch (_) { return ""; }
}

function getType(r) {
  const mime = String(r.mimeType || "").toLowerCase().split(";")[0].trim();
  const rt = String(r.resourceType || "").toLowerCase();

  if (mime === "text/html" || rt === "document") return "html";
  if (mime === "application/javascript" || mime === "text/javascript" || rt === "script") return "js";
  if (mime === "application/json" || mime === "text/json") return "json";
  if (mime === "text/css" || rt === "stylesheet") return "css";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/svg+xml") return "svg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") return "ico";
  if (mime === "font/woff") return "woff";
  if (mime === "font/woff2") return "woff2";
  if (mime === "font/ttf") return "ttf";
  if (mime === "font/otf") return "otf";
  if (mime === "application/wasm") return "wasm";
  if (mime === "application/pdf") return "pdf";
  if (rt === "xhr" || rt === "fetch") return "xhr/fetch";
  if (rt === "websocket") return "websocket";
  if (rt === "media") return "media";
  if (rt === "manifest") return "manifest";
  if (rt === "other") return mime || "other";
  if (mime) return mime;
  return rt || "other";
}

function defaultSteps() {
  return [{id: crypto.randomUUID(), name:"Step 1"}];
}
async function saveSteps() {
  await chrome.storage.local.set({steps});
}
async function loadSteps() {
  const x = await chrome.storage.local.get("steps");
  steps = x.steps || defaultSteps();
  selectedStep = Math.min(selectedStep, Math.max(0, steps.length - 1));
}
async function resetEverything() {
  const old = await chrome.storage.local.get("recorder");
  if (old.recorder?.sessionId) {
    try { await msg("delete-session", {sessionId: old.recorder.sessionId}); } catch (_) {}
    await chrome.storage.local.remove(`session-${old.recorder.sessionId}-rows`);
  }
  try { await msg("clear-all"); } catch (_) {}
  await chrome.storage.local.remove(["steps","domainFilters","typeFilters","exportMode","activeStepIndex"]);
  rows = []; groups = []; domains = new Map(); types = new Map(); sessionId = null;
  steps = defaultSteps(); selectedStep = 0;
  await saveSteps();
}

function renderSteps() {
  const el = $("steps"); el.innerHTML = "";
  steps.forEach((step,i) => {
    const wrap = document.createElement("div"); wrap.className="stepChip";
    const b = document.createElement("button");
    b.textContent = step.name || `Step ${i+1}`;
    b.className = i === selectedStep ? "active" : "";
    b.title = "Requests recorded after selecting this step go here";
    b.onclick = () => { selectedStep=i; renderSteps(); renderRequests(); };
    wrap.appendChild(b);
    if (i === selectedStep) {
      const input = document.createElement("input");
      input.value=step.name;
      input.title="Transaction Controller name";
      input.onchange=async()=>{step.name=input.value.trim()||`Step ${i+1}`;await saveSteps();renderSteps();renderRequests();};
      wrap.appendChild(input);
    }
    el.appendChild(wrap);
  });
}

function renderDomains() {
  const panel = $("domainPanel"), el = $("domains");
  if (!domains.size) { panel.hidden=true; el.innerHTML=""; return; }
  panel.hidden=false; el.innerHTML="";
  const saved = Object.fromEntries(domains);
  [...domains.keys()].sort().forEach(domain => {
    const label=document.createElement("label"); label.className="domain";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=saved[domain]!==false;
    cb.onchange=async()=>{domains.set(domain,cb.checked);await saveDomainFilters();};
    const span=document.createElement("span"); span.textContent=domain; span.title=domain;
    label.append(cb,span); el.appendChild(label);
  });
}
async function saveDomainFilters() {
  await chrome.storage.local.set({domainFilters:Object.fromEntries(domains)});
}
async function buildDomains() {
  const stored = await chrome.storage.local.get("domainFilters");
  const old = stored.domainFilters || {};
  domains = new Map();
  for (const r of rows) {
    const d=getDomain(r.url);
    if (d && !domains.has(d)) domains.set(d, old[d] !== false);
  }
  await saveDomainFilters();
  renderDomains();
}

function renderTypes() {
  const panel = $("typePanel"), el = $("types");
  if (!types.size) { panel.hidden = true; el.innerHTML = ""; return; }
  panel.hidden = false; el.innerHTML = "";
  [...types.keys()].sort().forEach(type => {
    const label = document.createElement("label"); label.className = "typeItem";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = types.get(type) !== false;
    cb.onchange = async () => {
      types.set(type, cb.checked);
      await saveTypeFilters();
      renderTypes(); renderRequests();
    };
    const span = document.createElement("span"); span.textContent = type; span.title = type;
    label.append(cb, span);
    el.appendChild(label);
  });
}
async function saveTypeFilters() {
  await chrome.storage.local.set({typeFilters:Object.fromEntries(types)});
}
async function buildTypes() {
  const stored = await chrome.storage.local.get("typeFilters");
  const old = stored.typeFilters || {};
  types = new Map();
  for (const r of rows) {
    const t = getType(r);
    if (t && !types.has(t)) types.set(t, old[t] !== false);
  }
  await saveTypeFilters();
  renderTypes();
}

function filteredRows() {
  return rows.filter(r => {
    const d=getDomain(r.url);
    if (d && domains.get(d)===false) return false;
    const t=getType(r);
    if (t && types.get(t)===false) return false;
    return true;
  });
}

function overlapGroups(items, threshold) {
  const sorted = [...items].sort((a,b) => a.startTime - b.startTime);
  const result = [];
  let i = 0;

  // Requests are grouped when they start as part of the same browser burst.
  // A request must begin close to the first request in the burst OR while the
  // current burst is still active. This avoids turning a long-running request
  // into a huge group with unrelated later requests.
  while (i < sorted.length) {
    const first = sorted[i];
    const group = [first];
    const firstStart = Number(first.startTime || 0);
    let burstEnd = Math.max(firstStart, Number(first.endTime || firstStart));
    let j = i + 1;

    while (j < sorted.length) {
      const r = sorted[j];
      const startTime = Number(r.startTime || 0);
      const endTime = Math.max(startTime, Number(r.endTime || startTime));

      const startsNearBurst = startTime <= firstStart + threshold;
      const overlapsActive = startTime <= burstEnd + threshold;

      if (startsNearBurst || overlapsActive) {
        group.push(r);
        burstEnd = Math.max(burstEnd, endTime);
        j++;
      } else {
        break;
      }
    }

    if (group.length > 1) {
      result.push({
        index: result.length + 1,
        ids: group.map(x => x.requestId)
      });
      i = j;
    } else {
      i++;
    }
  }

  return result;
}

function runGrouping(showMessage=false) {
  const threshold = Math.max(10, Number($("overlapMs").value || 25));
  groups = [];
  for (let si=0; si<steps.length; si++) {
    groups.push(...overlapGroups(
      filteredRows().filter(r=>(r.stepIndex??0)===si),
      threshold
    ));
  }
  renderRequests();
  if (showMessage) setMessage(`Automatically grouped ${groups.length} parallel group(s).`, "ok");
}

function renderRequests() {
  const el=$("requests"); const shown=filteredRows();
  $("count").textContent=`(${shown.length}/${rows.length})`;
  if(!shown.length){el.innerHTML='<div class="empty">No included requests.</div>';return;}
  el.innerHTML="";
  shown.forEach(r=>{
    const box=document.createElement("div");box.className="req";
    const top=document.createElement("div");top.className="reqTop";
    const method=document.createElement("span");method.className="method";method.textContent=r.method||"GET";
    const url=document.createElement("span");url.className="url";url.textContent=displayPath(r.url);url.title=r.url||"";
    const step=document.createElement("span");step.className="stepTag";step.textContent=steps[r.stepIndex??0]?.name||`Step ${(r.stepIndex??0)+1}`;
    const g=groups.find(x=>x.ids.includes(r.requestId));
    top.append(method,url,step);
    if(g){const p=document.createElement("span");p.className="parallel";p.textContent=`P${g.index}`;top.appendChild(p);}
    box.appendChild(top);el.appendChild(box);
  });
}

async function loadRows() {
  const result=await msg("get-session",{sessionId});
  rows=result.rows||[];
  const overlay=await chrome.storage.local.get(`session-${sessionId}-rows`);
  if(overlay[`session-${sessionId}-rows`]){
    const edited=overlay[`session-${sessionId}-rows`],byId=new Map(edited.map(x=>[x.id,x]));
    rows=rows.map(x=>byId.get(x.id)?{...x,...byId.get(x.id)}:x);
  }
}
async function persistRows(){await chrome.storage.local.set({[`session-${sessionId}-rows`]:rows});}

function headerEntries(headers) {
  return Object.entries(headers||{}).map(([k,v])=>`<elementProp name="" elementType="Header">
<stringProp name="Header.name">${escapeXml(k)}</stringProp>
<stringProp name="Header.value">${escapeXml(v)}</stringProp>
</elementProp>`).join("");
}
function headerManager(headers) {
  const entries=Object.entries(headers||{});
  if(!entries.length)return "";
  return `<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Headers" enabled="true">
<collectionProp name="HeaderManager.headers">${headerEntries(headers)}</collectionProp>
</HeaderManager><hashTree/>`;
}
function buildBaseUrlVariables() {
  const map=new Map(); let n=1;
  for(const r of filteredRows()){
    try{const u=new URL(r.url);const key=`${u.protocol}//${u.hostname}:${u.port||""}`;
      if(!map.has(key)) map.set(key,{variableName:`BASE_URL_${n++}`,domain:u.hostname,protocol:u.protocol.replace(":","")});
    }catch{}
  } return map;
}
function baseInfo(url,map){try{const u=new URL(url);return map.get(`${u.protocol}//${u.hostname}:${u.port||""}`)||null}catch{return null}}
function buildUserDefinedVariablesXml(map){return [...map.values()].map(v=>`<elementProp name="${escapeXml(v.variableName)}" elementType="Argument"><stringProp name="Argument.name">${escapeXml(v.variableName)}</stringProp><stringProp name="Argument.value">${escapeXml(v.domain)}</stringProp><stringProp name="Argument.metadata">=</stringProp></elementProp>`).join("")}

// Conservative response -> future request auto-correlation.
let correlationRules=[];
function flattenJson(obj,path='$',out=[]){
 if(obj===null||obj===undefined)return out;
 if(['string','number','boolean'].includes(typeof obj)){out.push({path,value:String(obj)});return out}
 if(Array.isArray(obj)){obj.forEach((v,i)=>flattenJson(v,`${path}[${i}]`,out));return out}
 Object.entries(obj).forEach(([k,v])=>flattenJson(v,`${path}.${k}`,out));return out;
}
function dynamicCandidate(v){v=String(v||'').trim();return v.length>=8&&(/^[A-Za-z0-9_-]+$/.test(v)||/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(v)||/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v))}
function requestContains(r,v){const all=[r.url||'',r.postData||'',...Object.values(r.requestHeaders||{})].join('\n');return all.includes(v)}
function buildCorrelationRules(){
 correlationRules=[];const a=[...filteredRows()].sort((x,y)=>(x.startTime||0)-(y.startTime||0));const used=new Set();
 for(let i=0;i<a.length;i++){
  let json;try{json=JSON.parse(a[i].responseBody||'')}catch{continue}
  for(const item of flattenJson(json)){
   if(!dynamicCandidate(item.value))continue;
   const targets=[];for(let j=i+1;j<a.length;j++)if(requestContains(a[j],item.value))targets.push(a[j].requestId);
   if(!targets.length)continue;
   let base='CORR_'+item.path.replace(/^\$\.?/,'').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_|_$/g,'').toUpperCase();if(base==='CORR_')base='CORR_VALUE';
   let name=base,k=2;while(used.has(name))name=`${base}_${k++}`;used.add(name);
   correlationRules.push({value:item.value,variableName:name,sourceRequestId:a[i].requestId,jsonPath:item.path,targetIds:targets});
  }
 } return correlationRules;
}
function correlateText(v){let x=String(v??'');for(const r of correlationRules)x=x.split(r.value).join(`\${${r.variableName}}`);return x}
function correlatedHeaders(h){const o={};for(const [k,v] of Object.entries(h||{}))o[k]=correlateText(v);return o}
function correlationExtractorsForRequest(id){return correlationRules.filter(r=>r.sourceRequestId===id).map(r=>`<JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract ${escapeXml(r.variableName)}" enabled="true"><stringProp name="JSONPostProcessor.referenceNames">${escapeXml(r.variableName)}</stringProp><stringProp name="JSONPostProcessor.jsonPathExprs">${escapeXml(r.jsonPath)}</stringProp><stringProp name="JSONPostProcessor.match_numbers">1</stringProp><stringProp name="JSONPostProcessor.compute_concat">false</stringProp><stringProp name="JSONPostProcessor.defaultValues">NOT_FOUND</stringProp></JSONPostProcessor><hashTree/>`).join('')}
function headerEntries(headers){return Object.entries(headers||{}).map(([k,v])=>`<elementProp name="" elementType="Header"><stringProp name="Header.name">${escapeXml(k)}</stringProp><stringProp name="Header.value">${escapeXml(v)}</stringProp></elementProp>`).join('')}
function headerManager(headers){const entries=Object.entries(headers||{});if(!entries.length)return '';return `<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Headers" enabled="true"><collectionProp name="HeaderManager.headers">${headerEntries(headers)}</collectionProp></HeaderManager><hashTree/>`}
function requestLabel(stepName,rq){return `${stepName}_RQ${String(rq).padStart(2,'0')}`}
function parallelLabel(stepName,rq,parallelNo){return `${requestLabel(stepName,rq)}_P${String(parallelNo).padStart(2,'0')}`}
function samplerDisplayUrl(r,domainVariables){try{const u=new URL(r.url),info=baseInfo(r.url,domainVariables),base=info?`\${${info.variableName}}`:u.origin;return `${base}${correlateText((u.pathname||'/')+(u.search||''))}`}catch{return correlateText(r.url||'')}}
function replaceBaseInHeaders(headers,domainVariables){const out={};const bases=[...domainVariables.values()].map(v=>({origin:`${v.protocol}://${v.domain}${v.port&& !((v.protocol==='https'&&v.port==='443')||(v.protocol==='http'&&v.port==='80'))?':'+v.port:''}`,variableName:v.variableName}));for(const [k,val] of Object.entries(headers||{})){let x=correlateText(val);for(const b of bases)x=x.split(b.origin).join(`\${${b.variableName}}`);out[k]=x}return out}
function httpSampler(r,domainVariables,label){let u;try{u=new URL(r.url)}catch{return ''}const port=u.port||(u.protocol==='https:'?'443':'80'),path=correlateText((u.pathname||'/')+(u.search||'')),body=correlateText(r.postData||''),info=baseInfo(r.url,domainVariables),domain=info?`\${${info.variableName}}`:u.hostname,display=`${label}|${samplerDisplayUrl(r,domainVariables)}`;return `<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${escapeXml(display)}" enabled="true"><elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" enabled="true"><collectionProp name="Arguments.arguments">${body?`<elementProp name="" elementType="HTTPArgument"><boolProp name="HTTPArgument.always_encode">false</boolProp><stringProp name="Argument.value">${escapeXml(body)}</stringProp><stringProp name="Argument.metadata">=</stringProp><boolProp name="HTTPArgument.use_equals">true</boolProp></elementProp>`:''}</collectionProp></elementProp><stringProp name="HTTPSampler.domain">${escapeXml(domain)}</stringProp><stringProp name="HTTPSampler.port">${escapeXml(port)}</stringProp><stringProp name="HTTPSampler.protocol">${escapeXml(u.protocol.replace(':',''))}</stringProp><stringProp name="HTTPSampler.path">${escapeXml(path)}</stringProp><stringProp name="HTTPSampler.method">${escapeXml(r.method)}</stringProp><boolProp name="HTTPSampler.follow_redirects">true</boolProp><boolProp name="HTTPSampler.auto_redirects">false</boolProp><boolProp name="HTTPSampler.use_keepalive">true</boolProp><boolProp name="HTTPSampler.postBodyRaw">${body?'true':'false'}</boolProp><boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp></HTTPSamplerProxy><hashTree>${headerManager(replaceBaseInHeaders(r.requestHeaders,domainVariables))}${correlationExtractorsForRequest(r.requestId)}</hashTree>`}
function transactionController(name,body){return `<TransactionController guiclass="TransactionControllerGui" testclass="TransactionController" testname="${escapeXml(name)}" enabled="true"><boolProp name="TransactionController.includeTimers">false</boolProp><boolProp name="TransactionController.parent">false</boolProp></TransactionController><hashTree>${body}</hashTree>`}
function parallelController(name,members,d,stepName,rq){const count=Math.max(2,members.length),body=members.map(r=>httpSampler(r,d,requestLabel(stepName,rq))).join('');return `<com.blazemeter.jmeter.controller.ParallelSampler guiclass="com.blazemeter.jmeter.controller.ParallelControllerGui" testclass="com.blazemeter.jmeter.controller.ParallelSampler" testname="${escapeXml(name)}" enabled="true"><intProp name="MAX_THREAD_NUMBER">${count}</intProp><boolProp name="PARENT_SAMPLE">true</boolProp><boolProp name="LIMIT_MAX_THREAD_NUMBER">false</boolProp></com.blazemeter.jmeter.controller.ParallelSampler><hashTree>${body}</hashTree>`}
function stepBodyStandard(si,d,stepName){const a=filteredRows().filter(r=>(r.stepIndex??0)===si).sort((a,b)=>a.startTime-b.startTime);return a.map((r,i)=>httpSampler(r,d,requestLabel(stepName,i+1))).join('')}
function stepBodyBlaze(si,d,stepName){const a=filteredRows().filter(r=>(r.stepIndex??0)===si).sort((a,b)=>a.startTime-b.startTime),gs=overlapGroups(a,Math.max(0,Number($("overlapMs").value||0))),m=new Map();gs.forEach(g=>g.ids.forEach(id=>m.set(id,g)));let o='',rq=1,parallelNo=1;const e=new Set();for(const r of a){if(e.has(r.requestId))continue;const g=m.get(r.requestId);if(g){const x=a.filter(z=>g.ids.includes(z.requestId));o+=parallelController(parallelLabel(stepName,rq,parallelNo),x,d,stepName,rq);x.forEach(z=>e.add(z.requestId));rq++;parallelNo++}else{o+=httpSampler(r,d,requestLabel(stepName,rq));e.add(r.requestId);rq++}}return o}
function listener(gui,name){return `<ResultCollector guiclass="${gui}" testclass="ResultCollector" testname="${name}" enabled="true"><boolProp name="ResultCollector.error_logging">false</boolProp><objProp><name>saveConfig</name><value class="SampleSaveConfiguration"><time>true</time><latency>true</latency><timestamp>true</timestamp><success>true</success><label>true</label><code>true</code><message>true</message><threadName>true</threadName><dataType>true</dataType><encoding>false</encoding><assertions>true</assertions><subresults>true</subresults><responseData>false</responseData><samplerData>false</samplerData><xml>false</xml><fieldNames>true</fieldNames></value></objProp><stringProp name="filename"></stringProp></ResultCollector><hashTree/>`}
function buildJmx(){const planName=$("testPlanName").value.trim()||"Chrome Recorded Test Plan",mode=$("exportMode").value,d=buildBaseUrlVariables();buildCorrelationRules();let stepsXml="";steps.forEach((s,i)=>{const stepName=(s.name||`Step ${i+1}`).trim().replace(/\s+/g,"_");const b=mode==="blazemeter"?stepBodyBlaze(i,d,stepName):stepBodyStandard(i,d,stepName);stepsXml+=transactionController(stepName,b)});const vars=buildUserDefinedVariablesXml(d);const xml=`<?xml version="1.0" encoding="UTF-8"?><jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3"><hashTree><TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${escapeXml(planName)}" enabled="true"><stringProp name="TestPlan.comments">Generated locally by Local HTTP/S Recorder.</stringProp><boolProp name="TestPlan.functional_mode">false</boolProp><boolProp name="TestPlan.serialize_threadgroups">false</boolProp><elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" enabled="true"><collectionProp name="Arguments.arguments"></collectionProp></elementProp><stringProp name="TestPlan.user_define_classpath"></stringProp></TestPlan><hashTree><Arguments guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true"><collectionProp name="Arguments.arguments">${vars}</collectionProp></Arguments><hashTree/><ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Recorded Thread Group" enabled="true"><stringProp name="ThreadGroup.on_sample_error">continue</stringProp><elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true"><boolProp name="LoopController.continue_forever">false</boolProp><stringProp name="LoopController.loops">1</stringProp></elementProp><stringProp name="ThreadGroup.num_threads">1</stringProp><stringProp name="ThreadGroup.ramp_time">0</stringProp><boolProp name="ThreadGroup.scheduler">false</boolProp></ThreadGroup><hashTree>${stepsXml}</hashTree>${listener("ViewResultsFullVisualizer","View Results Tree")}${listener("StatVisualizer","Aggregate Report")}</hashTree></hashTree></jmeterTestPlan>`;return xmlSafeText(xml)}

function harHeaders(headers){
  return Object.entries(headers||{}).map(([name,value])=>({name,value:String(value)}));
}
function harEntry(r){
  const start=new Date(r.startTime||Date.now()).toISOString();
  const total=Math.max(0,(r.endTime||r.startTime||Date.now())-(r.startTime||Date.now()));
  let u;
  try{u=new URL(r.url)}catch{u=null;}
  const req={
    method:r.method||"GET",url:r.url||"",httpVersion:"HTTP/1.1",
    headers:harHeaders(r.requestHeaders),queryString:u?[...u.searchParams].map(([name,value])=>({name,value})):[]
  };
  if(r.postData)req.postData={mimeType:r.requestHeaders?.["Content-Type"]||r.requestHeaders?.["content-type"]||"",text:r.postData};
  const res={
    status:Number(r.responseStatus||0),statusText:r.responseStatusText||"",httpVersion:r.protocol||"HTTP/1.1",
    headers:harHeaders(r.responseHeaders),content:{size:0,mimeType:r.mimeType||"",text:r.responseBody||""}
  };
  return {startedDateTime:start,time:total,request:req,response:res,cache:{},timings:{send:0,wait:total,receive:0}};
}
function buildHar(){
  const included=filteredRows().sort((a,b)=>a.startTime-b.startTime);
  return JSON.stringify({log:{
    version:"1.2",
    creator:{name:"Local JMX Recorder",version:"0.4.0"},
    entries:included.map(harEntry)
  }},null,2);
}
function downloadText(name,text,type){
  const blob=new Blob([text],{type});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

async function refreshState(){
  const result=await msg("get-state"),rec=result.recorder||{};
  recording=!!rec.recording;paused=!!rec.paused;
  sessionId=rec.sessionId||sessionId;
  if(recording) $("status").textContent=paused?"Paused":"Recording";
  else $("status").textContent=sessionId?"Stopped":"Idle";
  $("status").className=`badge ${recording?(paused?"paused":"recording"):"idle"}`;
  $("start").disabled=recording;
  $("pause").disabled=!recording;
  $("stop").disabled=!recording;
  $("newStep").disabled=!recording;
  if(sessionId){
    await loadRows(); await buildDomains(); renderSteps(); renderRequests();
    $("sessionPanel").hidden=false;
    $("exportPanel").hidden=false;
    $("flowInfo").textContent=`${rows.length} captured request(s)`;
  }
}

$("start").onclick=async()=>{
  setMessage("");
  try{
    await resetEverything();
    const r=await msg("start");
    if(!r.ok)throw new Error(r.error);
    sessionId=r.sessionId;recording=true;paused=false;
    steps=defaultSteps();selectedStep=0;
    await saveSteps();
    await chrome.storage.local.set({activeStepIndex:0});
    const started = new Date();
    const dd=String(started.getDate()).padStart(2,"0");
    const mm=String(started.getMonth()+1).padStart(2,"0");
    const yyyy=started.getFullYear();
    const hh=String(started.getHours()).padStart(2,"0");
    const mi=String(started.getMinutes()).padStart(2,"0");
    const ss=String(started.getSeconds()).padStart(2,"0");
    $("testPlanName").value=`recording_${dd}${mm}${yyyy}_${hh}${mi}${ss}.jmx`;
    await loadRows();await buildDomains();await buildTypes();renderSteps();runGrouping(false);
    $("sessionPanel").hidden=false;$("exportPanel").hidden=false;$("domainPanel").hidden=true;
    $("flowInfo").textContent="Recording new flow · Step 1";
    setMessage("New recording started. Previous data was reset.","ok");
    await refreshState();
  }catch(e){setMessage(e.message||String(e),"error");}
};

$("pause").onclick=async()=>{
  const r=await msg("pause");
  if(!r.ok)return setMessage(r.error,"error");
  paused=!!r.paused;
  $("status").textContent=paused?"Paused":"Recording";
  $("status").className=`badge ${paused?"paused":"recording"}`;
  setMessage(paused?"Recording paused. Click Resume to continue.":"Recording resumed.","ok");
  $("pause").textContent=paused?"▶ Resume":"Ⅱ Pause";
};

$("stop").onclick=async()=>{
  const r=await msg("stop");
  if(!r.ok)return setMessage(r.error,"error");
  recording=false;paused=false;$("pause").textContent="Ⅱ Pause";
  await refreshState();await buildDomains();await buildTypes();
  runGrouping(false);
  setMessage(`Recording stopped. ${groups.length} parallel group(s) detected automatically. Domains and types are ready for exclusion.`,"ok");
};

$("refresh").onclick=refreshState;

$("openWindow").onclick=async()=>{
  try{
    // Remember the web page that was active before the recorder window steals focus.
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (tab?.id && /^https?:/i.test(tab.url || "")) {
      await msg("set-target-tab", {tabId: tab.id});
    }
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 1000,
      height: 760
    });
  }catch(e){
    setMessage(`Unable to open window: ${e.message||e}`, "error");
  }
};


$("newStep").onclick=async()=>{
  if(!recording)return;
  steps.push({id:crypto.randomUUID(),name:`Step ${steps.length+1}`});
  selectedStep=steps.length-1;
  await saveSteps();
  await chrome.storage.local.set({activeStepIndex:selectedStep});
  $("flowInfo").textContent=`Recording · ${steps[selectedStep].name}`;
  renderSteps();runGrouping(false);
  setMessage(`${steps[selectedStep].name} started. New requests will be placed in this Transaction Controller.`,"ok");
};

$("selectAllDomains").onclick=async()=>{
  domains.forEach((_,k)=>domains.set(k,true));await saveDomainFilters();renderDomains();renderRequests();
};
$("clearDomains").onclick=async()=>{
  domains.forEach((_,k)=>domains.set(k,false));await saveDomainFilters();renderDomains();renderRequests();
};
$("selectAllTypes").onclick=async()=>{
  types.forEach((_,k)=>types.set(k,true));await saveTypeFilters();renderTypes();renderRequests();
};
$("clearTypes").onclick=async()=>{
  types.forEach((_,k)=>types.set(k,false));await saveTypeFilters();renderTypes();renderRequests();
};

$("exportMode").onchange=async e=>{
  await chrome.storage.local.set({exportMode:e.target.value});
  setMessage(e.target.value==="blazemeter"?"BlazeMeter Parallel export selected. Parallel groups are generated automatically.":"Standard JMeter export selected. Parallel groups are detected but cannot be represented without the BlazeMeter plugin.","ok");
};
$("captureBodies").onchange=async e=>chrome.storage.local.set({captureResponseBodies:e.target.checked});
$("maskSecrets").onchange=async e=>chrome.storage.local.set({maskSecrets:e.target.checked});
$("overlapMs").onchange=async e=>chrome.storage.local.set({overlapMs:Number(e.target.value||0)});

$("exportJmx").onclick=async()=>{
  const included=filteredRows();
  if(!included.length)return setMessage("Nothing included for export. Check at least one domain.","error");
  runGrouping(false);
  const entered=($("testPlanName").value.trim()||"recorded-test-plan").replace(/[<>:"/\\|?*]+/g,"_");
  const baseName=entered.replace(/\.jmx$/i,"");
  downloadText(`${baseName}.jmx`,buildJmx(),"application/xml");
  downloadText(`${baseName}.har`,buildHar(),"application/json");
  setMessage("JMX and HAR exported locally.","ok");
};

$("deleteSession").onclick=async()=>{
  if(sessionId)await msg("delete-session",{sessionId});
  await chrome.storage.local.remove(["steps","domainFilters","typeFilters","activeStepIndex",`session-${sessionId}-rows`]);
  rows=[];groups=[];domains=new Map();types=new Map();steps=defaultSteps();selectedStep=0;sessionId=null;
  renderSteps();renderRequests();renderDomains();renderTypes();$("sessionPanel").hidden=true;$("exportPanel").hidden=true;
  $("flowInfo").textContent="New recording";
  setMessage("Session deleted from local storage.","ok");
};

(async function init(){
  const s=await chrome.storage.local.get({
    captureResponseBodies:false,maskSecrets:true,overlapMs:50,exportMode:"blazemeter",
    domainFilters:{},typeFilters:{},activeStepIndex:0
  });
  $("captureBodies").checked=!!s.captureResponseBodies;
  $("maskSecrets").checked=s.maskSecrets!==false;
  $("overlapMs").value=s.overlapMs;
  $("exportMode").value=s.exportMode || "blazemeter";
  selectedStep=Number(s.activeStepIndex||0);
  await loadSteps();
  renderSteps();
  await refreshState();
  if(sessionId){
    await buildDomains();
    await buildTypes();
    runGrouping(false);
    if(!$("testPlanName").value || $("testPlanName").value==="Chrome Recorded Test Plan"){
      $("testPlanName").value=`recording_${new Date().toLocaleDateString("en-GB").replaceAll("/","")}_${new Date().toTimeString().slice(0,8).replaceAll(":","")}.jmx`;
    }
  }
})();
let liveRefreshTimer = null;
chrome.runtime.onMessage.addListener(m=>{
  if(m.type==="recording-state") refreshState();
  if(m.type==="recording-progress") {
    if (liveRefreshTimer) return;
    liveRefreshTimer = setTimeout(async () => {
      liveRefreshTimer = null;
      await refreshState();
      await buildTypes();
      runGrouping(false);
    }, 250);
  }
});
