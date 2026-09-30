'use strict';
const $ = (id) => document.getElementById(id);
let config, current, selectedID, generation = 0, activeID, starting = false;
const example = () => ({suite:{version:'benchforge-text-v1',id:'text-smoke',tasks:[
  {id:'arithmetic',prompt:config?.models[0] === 'echo' ? '4' : 'What is 2 + 2? Reply with only the number.',mode:'exact',expected:'4'},
  {id:'deliberate-fail',prompt:'14',mode:'exact',expected:'4'}]},models:config?.models || ['echo'],settings:{timeout_ms:10000,max_tokens:256,temperature:0}});
async function api(path, options) { const r = await fetch(path, options); const data = await r.json(); if(!r.ok) throw Error(data.error || `HTTP ${r.status}`); return data; }
const post = (body) => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const node = (tag, text, cls) => { const e=document.createElement(tag); if(text !== undefined)e.textContent=text; if(cls)e.className=cls; return e; };
function controls(){ $('start').disabled=starting || !!activeID; $('cancel').disabled=!current || current.id!==activeID; $('export').disabled=!current; }
function show(report){
 current=report; $('status').textContent=`${report.request.suite.id} · ${report.state.replaceAll('_',' ')}`;
 if(report.state === 'running')activeID=report.id; else if(activeID===report.id)activeID=null;
 const completed=report.results.filter(r=>!['queued','running','skipped'].includes(r.state)).length;
 $('progress').max=report.results.length || 1; $('progress').value=completed;
 $('summary').replaceChildren(...report.summaries.map(s=>node('div',`${s.model}: ${s.score_percent===null?'No comparable score':s.score_percent.toFixed(1)+'%'} · ${s.passed} pass / ${s.failed} fail / ${s.errors} errors / ${s.planned} planned`,'stat')));
 $('results').replaceChildren(...report.results.map(r=>{const e=node('div',undefined,'result');const h=node('div',undefined,'result-head');h.append(node('strong',`${r.task_id} · ${r.model}`),node('span',`${r.state} · ${r.duration_ms} ms`,`badge ${r.state}`));e.append(h);if(r.output.text)e.append(node('p',r.output.text));if(r.error)e.append(node('p',r.error));return e;}));
 if(report.error)$('error').textContent=report.error;controls();
}
async function refreshHistory(){
 const runs=await api('/api/runs'); activeID=runs.find(r=>r.state==='running')?.id;
 $('history').replaceChildren(...runs.map(r=>{const b=node('button',`${r.request.suite.id} · ${r.state} · ${new Date(r.started).toLocaleString()}`,'quiet');b.onclick=()=>select(r.id);return b;}));controls();return runs;
}
async function select(id){selectedID=id;const mine=++generation;try{const r=await api(`/api/runs/${id}`);if(mine===generation)show(r);}catch(e){if(mine===generation)$('error').textContent=e.message;}}
$('example').onclick=()=>{$('request').value=JSON.stringify(example(),null,2);};
$('start').onclick=async()=>{
 if(starting||activeID)return;starting=true;controls();$('error').textContent='';
 try{const request=JSON.parse($('request').value);const run=await api('/api/runs',post(request));selectedID=run.id;generation++;show(run);await refreshHistory();}catch(e){$('error').textContent=e.message;}finally{starting=false;controls();}
};
$('cancel').onclick=async()=>{if(!activeID)return;const id=activeID;$('cancel').disabled=true;try{await api(`/api/runs/${id}/cancel`,post({}));await select(id);await refreshHistory();}catch(e){$('error').textContent=e.message;controls();}};
$('export').onclick=()=>{if(!current)return;const blob=new Blob([JSON.stringify(current,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=node('a');a.href=url;a.download=`benchforge-${current.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
async function poll(){try{if(activeID){const id=activeID;const mine=generation;const r=await api(`/api/runs/${id}`);if(mine===generation && (selectedID===id || !selectedID))show(r);if(r.state!=='running'){if(activeID===id)activeID=null;await refreshHistory();}}}catch(e){$('error').textContent=e.message;}finally{setTimeout(poll,700);}}
(async()=>{try{config=await api('/api/config');$('provider').textContent=config.provider;$('request').value=JSON.stringify(example(),null,2);const runs=await refreshHistory();if(runs.length)await select(activeID||runs[0].id);poll();}catch(e){$('error').textContent=e.message;$('start').disabled=true;}})();
