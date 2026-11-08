/* Home resources. Design: Opus 5.5 Quiet Instrument. Server source: Runtipi system/load.
 * One visibility/desk-bound timer; server every 15s, AI 60s; no aggregation of account quotas.
 * Only read-only, sanitized numeric server fields enter this module. */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = v => v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  const pct = v => { const n=number(v); return n == null || n<0 || n>100 ? null : Math.round(n); };
  const S={server:null,serverAt:0,serverError:'',devices:null,devicesAt:0,devicesError:'',health:null,healthAt:0,healthError:'',ai:null,aiAt:0,aiError:'',timer:null,busy:null,controller:null,panel:null,tab:'server',opener:'server',openerEl:null,pressing:false,pick:null,shown:{},anim:{},dialWait:null,extra:new Set(),watch:new Set()};
  function normalize(j) {return {cpu:pct(j?.cpuLoad),memory:pct(j?.percentUsedMemory),disk:pct(j?.percentUsed),memoryTotal:number(j?.memoryTotal),diskUsed:number(j?.diskUsed),diskSize:number(j?.diskSize)};}
  const desktopHome = () => !!window.__wux && (window.__wux.homeOpen || !window.__wux.ws[window.__wux.cur]?.wins.length);
  const active = () => !document.hidden && (!!S.panel || desktopHome() || (window.__wos?.idx===0 && !window.__wos?.sheet && !window.__wos?.desks?.[0]?.wins.length));
  const holdInstallPrompt = on => window.WizardPwaInstall?.hold?.(on, 'resources');
  const staleServer = () => !!S.server && (!!S.serverError || Date.now()-S.serverAt>45000);
  const staleAI = p => !!S.aiError || p?.status==='stale' || !p?.fetchedAt || Date.now()-Date.parse(p.fetchedAt)>300000;
  function freshness(at,error,stale) { if(!at) return error?'Unavailable':'Connecting'; const sec=Math.max(0,Math.floor((Date.now()-at)/1000));const age=sec<60?`${sec}s ago`:`${Math.floor(sec/60)}m ago`;return `${stale?'Last read · ':''}${age}`; }
  function bar(value,kind) {return `<span class="rs-bar ${value==null?'rs-na':kind==='server'?(value>=90?'rs-hot':value>=70?'rs-high':''):(value<=15?'rs-low':'')}" ${value==null?'':`role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-label="${kind==='server'?'Used':'Remaining'} percent"`}><i style="--rs-value:${value??0}%"></i></span>`;}
  function serverCells(detail=false) {const j=S.server||{}, rows=[['CPU',j.cpu,'Processor used'],['Memory',j.memory,j.memoryTotal==null?'Capacity unavailable':`${j.memoryTotal} GB total`],['Disk',j.disk,j.diskUsed==null||j.diskSize==null?'Capacity unavailable':`${j.diskUsed} / ${j.diskSize} GB used`]];return rows.map(([name,v,sub])=>`<span class="rs-meter"><span class="rs-k">${name}</span><b class="${v>=90?'rs-warning':''}">${v==null?'Unavailable':v+'%'}</b>${bar(v,'server')}${detail?`<small>${esc(sub)}</small>`:''}</span>`).join('');}
  function weekly(p) {return p.limits?.find(l=>/weekly|week/i.test(l.label)&&!/scoped/i.test(l.id))||null;}
  function account(p) {const q=weekly(p),bad=p.status==='unavailable',stale=staleAI(p),v=bad?null:(q?.remainingPercent!=null?100-q.remainingPercent:null); /* Opinionated: show used, like server bars */const exhausted=p.limits?.some(l=>l.remainingPercent===0);return `<span class="rs-account ${stale&&!bad?'rs-stale':''}" data-res-account="${esc(p.id)}"><span class="rs-account-line"><span title="${esc(p.email||p.name)}">${esc(p.email?p.email.split('@')[0]:p.name)}${exhausted?'<i class="rs-account-alert" title="A quota window is exhausted">!</i>':''}</span><b class="${v!=null&&v>=85?'rs-warning':''}">${bad?(p.signedOut?'Signed out':'Unavailable'):v!=null?v+'%':q?'Unavailable':'No weekly limit'}</b></span>${bar(v,'server')}${bad?'<small>Usage unavailable</small>':stale?'<small>Last known reading</small>':''}</span>`;}
  // Paid overage (Claude "extra usage"): money left of the monthly cap, shown beside the plan so it can be watched
  // running down once the weekly window is spent. An enabled unknown cap is a status, never a numeric meter.
  function extraOf(p) {const x=p?.paid;if(p?.status==='unavailable'||!x||x.type!=='spend'||x.enabled===false)return null;const limit=number(x.limitMinor),n=number(x.usedMinor),used=n==null?null:Math.max(0,n);
    if(limit!=null&&limit<=0||limit==null&&x.enabled!==true)return null;
    return {enabled:true,used,left:limit==null||used==null?null:Math.max(0,limit-used),limit,exp:number(x.exponent)??2,cur:String(x.currency||'USD'),pct:limit==null||used==null?null:Math.min(100,Math.ceil(used/limit*100))};}
  const cash=(minor,exp,cur)=>{const v=minor/10**Math.max(0,exp),s=v.toLocaleString('en-US',{minimumFractionDigits:Number.isInteger(v)?0:Math.min(2,Math.max(0,exp)),maximumFractionDigits:Math.min(2,Math.max(0,exp))});return cur==='USD'?'$'+s:s+' '+cur;};
  function extraNote(x) {const used=number(x.used)??(number(x.limit)!=null&&number(x.left)!=null?x.limit-x.left:null);return `${used==null?'Spend unavailable':cash(used,x.exp,x.cur)+' spent'} · ${x.limit==null?'Balance and cap unavailable':cash(x.limit,x.exp,x.cur)+' cap'}`;}
  // A failed or rate-limited read (status unavailable/stale, paid missing) must never drop the extra cell: that freed its
  // slot for another ChatGPT account and looked like the feature had been reverted. Keep the last real reading per
  // account, clearly marked, until the provider reports again. Only an explicit "disabled" from a good read clears it.
  const EXTRA_KEY='wos.res.extra';
  const memo={get(){try{return JSON.parse(localStorage.getItem(EXTRA_KEY)||'{}')||{};}catch{return {};}},put(m){try{localStorage.setItem(EXTRA_KEY,JSON.stringify(m));}catch{}}};
  function extraFor(p) {const live=extraOf(p),m=memo.get(),id=String(p?.id||'');if(!id)return live;
    if(live){if(p.status==='ok'){m[id]={...live,at:Date.parse(p.fetchedAt)||Date.now()};memo.put(m);}return {...live,stale:p.status==='stale'};}
    if(p?.status==='ok'&&(p.paid?.enabled===false||!p.paid)){if(m[id]){delete m[id];memo.put(m);}return null;}
    const k=m[id];return k&&(number(k.limit)>0||k.enabled===true&&k.limit==null)?{...k,stale:true}:null;}
  function extraCell(p,x) {const label=`${p.name} extra`,old=x.stale||staleAI(p),known=x.pct!=null,note=extraNote(x);return `<span class="rs-account rs-extra ${old?'rs-stale':''}" data-res-account="${esc(p.id)}:extra" title="Extra usage: ${esc(known?cash(x.left,x.exp,x.cur)+' left of '+cash(x.limit,x.exp,x.cur):'Enabled · '+note)}${old?' (last known reading)':''}"><span class="rs-account-line"><span>${esc(label)}</span><b class="${known&&x.pct>=85?'rs-warning':''}">${known?x.pct+'%':'Enabled'}</b></span>${known?bar(x.pct,'server'):`<small>${esc(note)}</small>`}${old?'<small>Last known reading</small>':''}</span>`;}
  // Every subscription remains visible; do not silently rank accounts out of Home.
  /* One column per provider: its heading, then each of its subscriptions underneath. */
  function homeCells(providers) {
    const kind=p=>String(p.provider||p.id||'').split(':')[0];
    const counts=S.ai?.accountCounts||[];
    const ids=[...counts.map(c=>c.id),...providers.map(kind)].filter((v,i,a)=>v&&a.indexOf(v)===i);
    return ids.map(id=>{
      const c=counts.find(x=>x.id===id),mine=providers.filter(p=>kind(p)===id);
      const name=c?.name||mine[0]?.providerName||id.charAt(0).toUpperCase()+id.slice(1),n=c?.count??mine.length;
      const rows=mine.map(p=>{const x=extraFor(p);return account(p)+(x?extraCell(p,x):'');}).join('');
      return `<span class="rs-provider" data-provider-count="${esc(id)}"><span class="rs-provider-h">${esc(name)} <i>${n}</i></span>${rows}</span>`;
    }).join('');
  }
  // Devices (wizard-os spec/DEVICES.md): this box first, then every machine the Wizard was given access to,
  // then the rest of the tailnet with online lights. Nothing here names a specific machine.
  const DOT={online:'Online',stale:'Last reading',offline:'Offline',unreachable:'Online · not reachable',connecting:'Connecting'};
  const ago=iso=>{const t=Date.parse(iso);if(!Number.isFinite(t))return '';const m=Math.max(0,Math.round((Date.now()-t)/60000));return m<1?'just now':m<60?m+'m ago':m<2880?Math.round(m/60)+'h ago':Math.round(m/1440)+'d ago';};
  const devList=()=>Array.isArray(S.devices?.devices)?S.devices.devices:[];
  const diskOf=d=>Array.isArray(d?.disks)?d.disks.filter(x=>x&&typeof x.label==='string'):[];
  // Problems worth a glance from Home: another device offline, or any disk at 90%+.
  function deviceAlerts(){const out=[];for(const d of devList()){if(d.kind==='this')continue;if(d.status==='offline'||d.status==='unreachable')out.push(`${d.name} ${d.status==='offline'?'offline':'not reachable'}`);else for(const x of diskOf(d))if(pct(x.pct)>=90)out.push(`${d.name} ${diskOf(d).length>1?x.label.toLowerCase()+' ':'disk '}${pct(x.pct)}% full`);}return out;}
  function deviceCard(d){const me=d.kind==='this',j=me&&S.server?S.server:null,disks=diskOf(d),main=disks[0]||null;
    const cpu=j?j.cpu:pct(d.cpu),mem=j?j.memory:pct(d.memory),disk=j?j.disk:pct(main?.pct);
    const memSub=j?.memoryTotal!=null?`${j.memoryTotal} GB total`:number(d.memoryTotalGB)!=null?`${number(d.memoryUsedGB)??'?'} / ${number(d.memoryTotalGB)} GB`:'';
    const diskSub=j?.diskUsed!=null&&j?.diskSize!=null?`${Math.max(0,j.diskSize-j.diskUsed)} GB free`:main?`${number(main.freeGB)} GB free`:'';
    const cell=(name,v,sub)=>`<span class="rs-meter"><span class="rs-k">${name}</span><b class="${v>=90?'rs-warning':''}">${v==null?'—':v+'%'}</b>${bar(v,'server')}${sub?`<small>${esc(sub)}</small>`:''}</span>`;
    const status=me?(S.server&&!S.serverError?'online':S.server?'stale':d.status):d.status;
    const when=me&&S.serverAt?freshness(S.serverAt,S.serverError,staleServer()):d.readAt?(status==='online'?ago(d.readAt):'Last read · '+ago(d.readAt)):d.lastSeen?'Seen '+ago(d.lastSeen):DOT[status]||'';
    const plat=d.platform==='macos'?'macOS':d.platform==='linux'?'Linux':'';
    const extra=disks.length>1?`<div class="rs-disks">${disks.map(x=>{const v=pct(x.pct);return `<div class="rs-disk"><span class="rs-account-line"><span>${esc(x.label)}</span><b class="${v>=90?'rs-warning':''}">${v==null?'—':v+'%'}</b></span>${bar(v,'server')}<small>${number(x.freeGB)} GB free of ${number(x.sizeGB)} GB</small></div>`;}).join('')}</div>`:'';
    const live=status==='online'||status==='stale';
    return `<article class="rs-device rs-st-${esc(status)}" data-device="${esc(d.id)}"><header class="rs-device-head"><i class="rs-dot" title="${esc(DOT[status]||status)}"></i><span class="rs-device-name"><b>${esc(d.name)}</b><small>${esc([d.role,plat].filter(Boolean).join(' · '))}</small></span><small class="rs-device-when ${status==='stale'?'rs-warning':''}">${esc(when)}</small></header>${live||me?`<div class="rs-meters rs-device-meters ${status==='stale'?'rs-stale':''}">${cell('CPU',cpu,d.cpus?`${number(d.cpus)} cores`:'')}${cell('Memory',mem,memSub)}${cell('Disk',disk,diskSub)}</div>${extra}`:`<p class="rs-device-off">${esc(status==='offline'?'Offline'+(d.lastSeen?' · last seen '+ago(d.lastSeen):''):status==='unreachable'?'Online, but the Wizard could not read it':'Connecting…')}</p>`}</article>`;}
  /* Miguel's skins (23 Oct): devices in three groups. Agent devices = machines the Wizard reads and runs work on, each
     with the same fuel gauges as Home (what is left) and one total line; Your devices = the owner's own phones and
     laptops (online light only); Client Wizards = boxes run for clients (online light only); Other = the rest. */
  const GNAME={human:'Your devices',client:'Client Wizards',other:'Other'};
  const osName=o=>({ios:'iPhone',android:'Android',macos:'macOS',windows:'Windows',linux:'Linux'})[String(o||'').toLowerCase()]||o||'';
  function devReading(d){const me=d.kind==='this',j=me&&S.server?S.server:null,main=diskOf(d)[0]||null;
    return {cpu:j?j.cpu:pct(d.cpu),mem:j?j.memory:pct(d.memory),disk:j?j.disk:pct(main?.pct),free:main?number(main.freeGB):null,cores:number(d.cpus),ram:number(d.memoryTotalGB)};}
  function groupedDevicesHtml(){const list=devList().length?devList():[{id:'this',kind:'this',group:'agent',name:'This server',role:'Wizard runs here',status:S.server?'online':'connecting',disks:[]}];
    const agents=list.filter(d=>(d.group||'agent')==='agent'),net=S.devices?.network,peers=net?.available&&Array.isArray(net.peers)?net.peers:[];
    const isOn=d=>d.status==='online'||d.status==='stale'||d.kind==='this';
    /* Capacity bars (Miguel, 23 Oct): one bar per resource, split by machine. Segment length = that machine's real
       capacity, fill = used, amber/red when little is left. A bigger machine simply owns more of the bar. */
    const M=agents.filter(isOn).map(d=>{const r=devReading(d),main=diskOf(d)[0]||null,me=d.kind==='this'&&S.server;
      const dsize=me&&number(S.server.diskSize)!=null?number(S.server.diskSize):number(main?.sizeGB);
      return {d,cpu:{cap:r.cores,used:r.cpu},mem:{cap:r.ram,used:r.mem},disk:{cap:dsize,used:r.disk}};});
    const fmt=(k,v)=>k==='cpu'?`${v} ${v===1?'core':'cores'}`:v>=1000?(v/1000).toFixed(1)+' TB':v+' GB';
    const bar=(k,name)=>{const segs=M.filter(m=>number(m[k].cap)>0),tot=segs.reduce((a,m)=>a+m[k].cap,0);if(!tot)return '';
      const free=segs.reduce((a,m)=>a+m[k].cap*(100-(m[k].used??0))/100,0);
      return `<div class="rs-cap" data-cap="${k}"><div class="rs-cap-h"><b>${name}</b><span>${esc(fmt(k,Math.round(free)))} free of ${esc(fmt(k,Math.round(tot)))}</span></div><div class="rs-cap-bar">${segs.map(m=>{const u=m[k].used,l=u==null?null:100-u;
        return `<div class="rs-cap-col" style="flex:${m[k].cap} 1 0"><button class="rs-cap-seg${l!=null&&l<25?' rs-empty':''}${l!=null&&l<10?' rs-crit':''}" data-dvpick="${esc(m.d.id)}" title="${esc(m.d.name)}: ${esc(fmt(k,m[k].cap))}${u!=null?`, ${u}% used`:''}" aria-label="${esc(m.d.name)} ${esc(name)} ${esc(fmt(k,m[k].cap))}${u!=null?`, ${100-u}% left`:''}"><i style="width:${u==null?0:Math.max(100-u,2)}%"></i></button>${k==='mem'?`<small>${esc(m.d.name.split(' ')[0])}</small>`:''}</div>`;}).join('')}</div></div>`;};
    const row=d=>{const r=devReading(d),on=isOn(d),main=diskOf(d)[0]||null;
      const facts=on?[r.cores!=null?fmt('cpu',r.cores):'',r.ram!=null?r.ram+' GB RAM':'',r.free!=null?fmt('disk',r.free)+' free':''].filter(Boolean).join(' · '):(d.status==='offline'?'Offline'+(d.lastSeen?' · seen '+ago(d.lastSeen):''):d.status==='unreachable'?'Online, but the Wizard can\u2019t read it':'Connecting…');
      return `<li class="rs-dv-m rs-st-${esc(d.status)}${S.pick===d.id?' rs-picked':''}" data-dvrow="${esc(d.id)}"><i class="rs-dot"></i><span><b>${esc(d.name)}</b><small>${esc(osName(d.platform))}</small></span><em>${esc(facts)}</em></li>`;};
    const by={human:[],client:[],other:[]};for(const p of peers)(by[p.group]||by.other).push(p);
    const lights=k=>by[k].length?`<section class="rs-dv-g"><h3>${GNAME[k]}</h3><ul class="rs-dv-net">${by[k].map(p=>`<li class="${p.online?'rs-st-online':'rs-st-offline'}"><i class="rs-dot"></i><span>${esc(p.name==='localhost'&&/ios/i.test(p.os)?'iPhone':p.name)}</span><small>${esc(p.online?(/ios/i.test(p.os)?'iOS':osName(p.os)):'Offline'+(p.lastSeen?' · '+ago(p.lastSeen):''))}</small></li>`).join('')}</ul></section>`:'';
    return `<div class="rs-dv-wrap"><section class="rs-dv-g"><h3>Agent devices</h3><div class="rs-caps">${bar('mem','Memory')}${bar('disk','Disk')}${bar('cpu','CPU')}</div><ul class="rs-dv-ms">${agents.map(row).join('')}</ul></section>${lights('human')}${lights('client')}${lights('other')}${S.devicesError&&!S.devices?'<p class="rs-detail-note">Other devices unavailable right now.</p>':''}</div>`;}
  function devicesHtml(){if(ours())return groupedDevicesHtml();const list=devList().length?devList():[{id:'this',kind:'this',name:'This server',role:'Wizard runs here',status:S.server?'online':'connecting',disks:[]}];const net=S.devices?.network;
    const peers=net?.available&&Array.isArray(net.peers)?net.peers:[];
    return `<div class="rs-devices">${list.map(deviceCard).join('')}</div>${S.devicesError&&!S.devices?'<p class="rs-detail-note">Other devices unavailable right now.</p>':''}${peers.length?`<h3 class="rs-net-h">On your network</h3><ul class="rs-net">${peers.map(p=>`<li class="${p.online?'rs-st-online':'rs-st-offline'}"><i class="rs-dot"></i><span>${esc(p.name)}</span><small>${esc(p.os||'')}${!p.online&&p.lastSeen?' · '+esc(ago(p.lastSeen)):''}</small></li>`).join('')}</ul><p class="rs-detail-note rs-net-hint">Ask your Wizard to monitor any machine it can reach.</p>`:''}`;}
  // Health checks (tools/system-health.mjs): the install's watchdog results. Problems first; Home shows one tappable line.
  const HSTAT={error:'Needs attention',warn:'Warning',ok:'OK'},HRANK={error:0,warn:1,ok:2};
  const HABOUT={'root-inodes':'The server is running out of room for new files (it can hold only so many, however small). Clearing caches or old build folders fixes it.','services':'Services currently in a failed state. Zero means everything monitored is running cleanly.','hermes-backup':'Freshness, health check, storage and retained copies of the encrypted Hermes backup.','scheduled-jobs':'Your Wizard’s recurring jobs (briefs, watchers, syncs). A failing job is retried by the repair worker before you hear about it.','voice':'Checks the speech service currently used by Wizard. A failure means voice transcription is unavailable; an unchecked result means its availability is unknown.','claude-signin':'The agent’s Claude account. Signed out means it cannot think with Claude until it signs in again.','disk-runway':'A forecast from the last week of free space, so you hear about a filling disk before it is full.'};
  const healthChecks=()=>S.health?.available&&Array.isArray(S.health.checks)?S.health.checks:[];
  function healthProblems(){const h=S.health;if(!h?.available)return [];const out=healthChecks().filter(c=>c.status!=='ok').sort((a,b)=>HRANK[a.status]-HRANK[b.status]).map(c=>({status:c.status,text:`${c.label} ${c.value||HSTAT[c.status].toLowerCase()}`}));if(h.stale)out.push({status:'warn',text:h.checkedAt?`Health checks last ran ${ago(h.checkedAt)}`:'Health checks have not reported'});return out;}
  function healthAlert(){const list=healthProblems();if(!list.length)return '';const bad=list.some(x=>x.status==='error');return `<button class="rs-health-alert ${bad?'rs-health-error':''}" data-res-open="health" aria-label="Health: ${esc(list.map(x=>x.text).join(', '))}. Open health checks"><i class="rs-dot"></i><span>${esc(list.map(x=>x.text).join(' · '))}</span><em>›</em></button>`;}
  function healthHtml(){const h=S.health;
    if(!h)return `<p class="rs-detail-note">${S.healthError?'Health checks unavailable right now.':'Reading health checks…'}</p>`;
    if(!h.available)return '<p class="rs-detail-note">No health checks are set up on this server yet. Ask your Wizard to watch disk, memory, services or backups and they will appear here.</p>';
    const list=[...healthChecks()].sort((a,b)=>HRANK[a.status]-HRANK[b.status]),n=h.counts||{},bad=(n.error||0)+(n.warn||0);
    const when=h.checkedAt?(h.stale?'Last check '+ago(h.checkedAt):'Checked '+ago(h.checkedAt)):'Never checked';
    return `<p class="rs-health-sum ${h.stale||S.healthError?'rs-warning':''}">${esc(`${list.length} check${list.length===1?'':'s'} · ${bad?`${bad} need${bad===1?'s':''} attention`:'all healthy'} · ${when}`)}${S.healthError?' · showing last reading':''}</p><ul class="rs-health ${h.stale?'rs-stale':''}">${list.map(c=>`<li class="rs-h-${esc(c.status)}" data-health="${esc(c.key)}"><div class="rs-health-line"><i class="rs-dot" title="${esc(HSTAT[c.status])}"></i><b>${esc(c.label)}</b><span>${esc(c.value||HSTAT[c.status])}</span></div>${c.detail?`<p>${esc(c.detail)}</p>`:''}${HABOUT[c.key]?`<small>${esc(HABOUT[c.key])}</small>`:''}</li>`).join('')}</ul>`;}
  function html() {if(ours())return homeBarsHtml();const j=S.server||{},ss=staleServer(),providers=S.ai?.providers||[],ts=providers.filter(p=>p.fetchedAt&&p.status!=='unavailable').map(p=>Date.parse(p.fetchedAt)).filter(Number.isFinite),at=ts.length?Math.min(...ts):0;return `<section class="rs-widget wz-home-widget" aria-label="Server and AI resources"><button class="rs-zone ${ss?'rs-stale':''}" data-res-open="server"><span class="rs-heading"><span>Server <i>· used</i> <em>›</em></span><small class="${ss?'rs-warning':''}">${esc(freshness(S.serverAt,S.serverError,ss))}</small></span><span class="rs-meters">${serverCells()}</span>${(()=>{const notes=[...(j.disk>=90?[`Disk ${j.disk}% full`]:[]),...deviceAlerts()];return notes.length?`<span class="rs-warning-note">${esc(notes.join(' · '))}</span>`:'';})()}</button>${healthAlert()}<button class="rs-zone" data-res-open="ai"><span class="rs-heading"><span>AI <i>· week used</i> <em>›</em></span><small>${esc(freshness(at||S.aiAt,S.aiError,!!S.aiError||providers.some(staleAI)))}</small></span><span class="rs-accounts">${providers.length||(S.ai?.accountCounts||[]).length?homeCells(providers):`<span class="rs-unavailable">${S.aiError?'AI usage unavailable':'Connecting to AI accounts…'}</span>`}</span></button></section>`;}
  /* Miguel's skins (Dark, Light, Landscapes): Home shows one quiet row of ring dials per zone, every dial in the same
     column grid so Server and AI line up. No warning notes, alert marks, health line or freshness text; the detail sheet
     keeps all of that. An AI account that can't be read is a dial that opens its connection app to sign back in. */
  const ours=()=>typeof document!=='undefined'&&(document.documentElement.dataset.tweaks||'').split(' ').includes('miguel/home-bars');
  const APP_OF={chatgpt:'wizard-chatgpt',claude:'wizard-claude',tinfoil:'wizard-tinfoil'};
  const RECONNECT_APPS=new Set(['wizard-chatgpt','wizard-claude']);
  /* Speedometer dials (Miguel's skins, 22 Oct): a 240° car gauge per reading. Each dial remembers what it last showed
     (S.shown) and every render starts from there, so Home re-renders never jump; settle() then moves the needle, arc
     and number to the new reading. First reading of a session = needles sweep up from zero, staggered, like a car's
     cluster on start. Before a reading lands the dial already sits at zero, so nothing pops in. */
  const GKEY='wos.res.dials';
  const gauge='<svg viewBox="0 0 60 50" aria-hidden="true"><path class="rs-track" d="M9.22 42A24 24 0 1 1 50.78 42"/><path class="rs-arc" pathLength="100" d="M9.22 42A24 24 0 1 1 50.78 42"/>'+
    Array.from({length:11},(_,i)=>{const a=(-120+i*24)*Math.PI/180,r1=i%5?18.6:16.6,r2=20.4;return `<line class="rs-tick${i%5?'':' rs-major'}" x1="${(30+r1*Math.sin(a)).toFixed(2)}" y1="${(30-r1*Math.cos(a)).toFixed(2)}" x2="${(30+r2*Math.sin(a)).toFixed(2)}" y2="${(30-r2*Math.cos(a)).toFixed(2)}"/>`;}).join('')+
    '<g class="rs-ndl"><path d="M29.1 30.6L30 11.5L30.9 30.6Z"/></g><circle class="rs-hub" cx="30" cy="30" r="2.2"/></svg>';
  const ang=v=>`rotate(${(-120+2.4*Math.max(0,Math.min(100,v))).toFixed(1)}deg)`;
  // In-flight sweeps live in S.anim so a Home re-render mid-sweep picks up where the needle is instead of snapping.
  const ease=x=>1-Math.pow(1-x,3);
  function cur(k){const a=S.anim[k];if(!a)return S.shown[k]??0;const x=Math.max(0,Math.min(1,(performance.now()-a.t0)/a.dur));return a.from+(a.to-a.from)*ease(x);}
  function dial(sp,i){const k=sp.k,now=cur(k),off=sp.signin||sp.off,known=k in S.shown||!!S.anim[k];
    return `<button class="rs-dial ${off?'rs-dial-off':''}${sp.fuel?' rs-fuel':''}${sp.fuel&&sp.v!=null&&sp.v<25?' rs-empty':''}${sp.fuel&&sp.v!=null&&sp.v<10?' rs-crit':''}" data-k="${esc(k)}" data-t="${sp.v??''}"${sp.money?` data-money="${esc(sp.money)}"`:''} style="--i:${i}" ${sp.attrs} ${sp.title?`title="${esc(sp.title)}"`:''} ${sp.v!=null?`role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${sp.v}"`:''} aria-label="${esc(sp.label)} ${sp.money?esc(sp.money)+' credit left':sp.v!=null?sp.v+'% left':esc(sp.sub||'loading')}"><span class="rs-gauge" style="--a:${ang(now)};--o:${(100-now).toFixed(1)}">${gauge}${sp.fuel&&i===0?'<i class="rs-e">E</i><i class="rs-f">F</i>':''}<b>${sp.money?sp.money:known&&!off?Math.round(now):''}</b></span><span class="rs-dl">${esc(sp.label)}${sp.signin?`<small>${esc(sp.sub)}</small>`:''}</span></button>`;}
  function dialSpecs(){const j=S.server||{},kind=p=>String(p.provider||p.id||'').split(':')[0];
    /* Every dial is a fuel gauge of what is LEFT (Miguel, 23 Oct): free CPU / memory / disk, weekly quota remaining. Low = trouble. */
    const left=v=>v==null?null:Math.max(0,Math.min(100,100-v));
    const out=[['CPU',j.cpu],['Memory',j.memory],['Disk',j.disk]].map(([k,v])=>({k,label:k,v:left(v),fuel:true,attrs:'data-res-open="server"',row:'s',off:!S.server&&!!S.serverError}));
    if(S.ai){const providers=S.ai.providers||[],per={},seen={};for(const p of providers)per[kind(p)]=(per[kind(p)]||0)+1;
      const ai=providers.flatMap(p=>{const id=kind(p),n=per[id]>1?(seen[id]=(seen[id]||0)+1):0;
        const full=p.providerName||(p.name&&!p.email?p.name:'')||id.charAt(0).toUpperCase()+id.slice(1),label=(full==='ChatGPT'?'GPT':full)+(n?' '+n:'');
        const q=weekly(p),bad=p.status==='unavailable',v=bad||q?.remainingPercent==null?null:Math.max(0,Math.min(100,Math.round(q.remainingPercent)));
        const rows=bad||q?[bad&&APP_OF[id]?{k:'ai:'+p.id,label,v:null,signin:true,sub:'Reconnect',attrs:`data-res-signin="${esc(APP_OF[id])}" data-res-reconnect="1"`,title:p.email||label,row:'a'}:{k:'ai:'+p.id,label,v,fuel:true,attrs:'data-res-open="ai"',title:p.email||label,row:'a'}]:[];
        const x=extraFor(p);if(x){const old=x.stale||staleAI(p);rows.push({k:'extra:'+p.id,label:label+' extra',v:x.pct==null?null:100-x.pct,extra:true,note:extraNote(x)+(old?' · Last known reading':''),attrs:'data-res-open="ai"',row:'a'});}return rows;});
      /* Credit accounts (Tinfoil): a fuel gauge, E to F. Full = the last top-up; the readout is dollars left, not a percent. */
      for(const p of providers){const x=p.paid;if(p.status==='unavailable'||!x||x.type!=='credits'||number(x.balanceMinor)==null)continue;
        const id=kind(p),bal=number(x.balanceMinor),cap=number(x.limitMinor),ex=number(x.exponent)??2,v=cap>0?Math.max(0,Math.min(100,Math.round(bal/cap*100))):(bal>0?100:0);
        const full=p.providerName||(p.name&&!p.email?p.name:'')||id.charAt(0).toUpperCase()+id.slice(1),left=bal/10**ex;
        ai.push({k:'fuel:'+p.id,label:full,v,fuel:true,money:"$"+(left>=10||Number.isInteger(left)?Math.floor(left):left.toFixed(2)),attrs:APP_OF[id]?`data-res-signin="${esc(APP_OF[id])}"`:'data-res-open="ai"',title:`${cash(bal,ex,x.currency||'USD')} credit left`,row:'a'});}
      try{localStorage.setItem(GKEY,JSON.stringify(ai.map(a=>({k:a.k,label:a.label,fuel:!!a.fuel}))));}catch{}
      return out.concat(ai);}
    let last=[];try{last=JSON.parse(localStorage.getItem(GKEY)||'[]')||[];}catch{}
    return out.concat(last.filter(a=>a&&a.k&&a.label).map(a=>({k:String(a.k),label:String(a.label),fuel:true,v:null,attrs:'data-res-open="ai"',row:'a',off:!!S.aiError})));}
  const dialSig=specs=>specs.map(s=>`${s.k}|${s.label}|${s.signin?1:0}`).join(',');
  function dialHtml(){const specs=dialSpecs(),sv=specs.filter(s=>s.row==='s'),ai=specs.filter(s=>s.row==='a');
    const row=(h,cells,o)=>`<div class="rs-dials" role="group" aria-label="${h}">${cells.map((c,i)=>dial(c,i+o)).join('')}</div>`;
    return `<section class="rs-widget rs-dialed wz-home-widget" style="--n:${Math.max(sv.length,ai.length,1)}" data-sig="${esc(dialSig(specs))}" aria-label="Server and AI resources">${ai.length?row('AI week left',ai,0):''}${row('Server',sv,ai.length)}</section>`;}
  /* Home as bars (Miguel, 23 Oct): AI accounts first, then Memory / Disk / CPU split by machine (segment length = real
     capacity). Every fill shows what is LEFT; amber under a quarter, red under a tenth. Fills grow from zero on first
     paint and glide afterwards. Tap AI to open AI accounts, compute to open devices. */
  function homeRows(){const kind=p=>String(p.provider||p.id||'').split(':')[0],rows={ai:[],hw:[]};
    for(const sp of dialSpecs().filter(x=>x.row==='a'))rows.ai.push({k:sp.k,label:sp.label,segs:sp.extra&&sp.v==null?[]:[{cap:1,left:sp.v,title:sp.title||sp.label}],value:sp.signin?'Sign in':sp.money?sp.money+' left':(sp.v==null?(sp.extra?'Enabled':''):(100-sp.v)+'%'),extra:sp.extra,note:sp.note,signin:sp.signin,attrs:sp.attrs,left:sp.v});
    const list=devList().length?devList():[{id:'this',kind:'this',group:'agent',name:'This server',status:'online',disks:[]}];
    const M=list.filter(d=>(d.group||'agent')==='agent'&&(d.status==='online'||d.status==='stale'||d.kind==='this')).map(d=>{const r=devReading(d),main=diskOf(d)[0]||null,me=d.kind==='this'&&S.server;
      return {d,mem:{cap:r.ram,used:r.mem},disk:{cap:me&&number(S.server.diskSize)!=null?number(S.server.diskSize):number(main?.sizeGB),used:r.disk},cpu:{cap:r.cores,used:r.cpu}};});
    const fmt=(k,v)=>k==='cpu'?`${v} ${v===1?'core':'cores'}`:v>=1000?(v/1000).toFixed(1)+' TB':v+' GB';
    for(const [k,label] of [['mem','Memory'],['disk','Disk'],['cpu','CPU']]){
      let segs=M.filter(m=>number(m[k].cap)>0&&m[k].used!=null);
      // Before the devices list arrives, this box alone (percent only) so Home never waits on other machines.
      if(!segs.length){const j=S.server||{},v=k==='mem'?j.memory:k==='disk'?j.disk:j.cpu;rows.hw.push({k:'hw:'+k,label,segs:[{cap:1,left:v==null?null:100-v,title:label}],value:v==null?'':v+'%',attrs:'data-res-open="server"',left:v==null?null:100-v});continue;}
      const tot=segs.reduce((a,m)=>a+m[k].cap,0),free=segs.reduce((a,m)=>a+m[k].cap*(100-m[k].used)/100,0);
      rows.hw.push({k:'hw:'+k,label,segs:segs.map(m=>({dv:M.indexOf(m),cap:m[k].cap,left:100-m[k].used,title:`${m.d.name}: ${fmt(k,Math.round(m[k].cap*m[k].used/100))} used of ${fmt(k,m[k].cap)}`})),value:`${Math.round(tot-free)}/${fmt(k,Math.round(tot))}`,attrs:'data-res-open="server"',left:Math.round(free/tot*100)});}
    rows.machines=M.map(m=>m.d.name);
    return rows;}
  const lvl=v=>v==null?'':v<10?' rs-crit':v<25?' rs-empty':'';
  /* Bar groups, in order. Each takes the rows from homeRows(); a third group (say, storage or money) is one more entry
     here with its own rows key. Home (on skins that draw bars) and Settings › Resources both draw from this list (WosResources.bars). */
  const GROUPS=[
    {id:'ai',cls:'rs-bg-ai',title:'AI resources',sub:'used this week',label:'AI resources used this week',optional:true},
    {id:'hw',cls:'rs-bg-hw',title:'Compute resources',sub:'used',label:'Compute resources used',legend:true},
  ];
  function homeBarsHtml(){const R=homeRows(),sig=GROUPS.flatMap(g=>R[g.id]||[]).map(r=>r.k+':'+r.segs.length+(r.signin?'s':'')+(r.note?'|'+r.note:'')).join(',');
    const row=r=>`<button class="rs-br${r.signin?' rs-br-off':''}${r.extra?' rs-br-extra':''}${!r.segs.length?' rs-br-indeterminate':''}" data-k="${esc(r.k)}" ${r.attrs} aria-label="${esc(r.label)} ${esc(r.signin?'sign in':r.value==='Enabled'||/left$/.test(r.value)?r.value:r.value+' used')}${r.note?' · '+esc(r.note):''}"><span class="rs-bl">${esc(r.label)}</span>${r.segs.length?`<span class="rs-bt">${r.segs.map(g=>`<i class="rs-bs${lvl(g.left)}${g.dv!=null?' rs-d'+(g.dv%4):''}" style="flex:${g.cap} 1 0" title="${esc(g.title)}"><i class="rs-bf" data-w="${g.left==null?0:100-g.left}" style="width:0%"></i></i>`).join('')}</span>`:''}<span class="rs-bv${lvl(r.left)}">${esc(r.value)}</span>${r.note?`<small class="rs-br-note">${esc(r.note)}</small>`:''}</button>`;
    const legend=()=>(R.machines||[]).length>1?`<p class="rs-lg">${R.machines.map((n,i)=>`<span class="rs-d${i%4}"><i></i>${esc(n.split(' ')[0])}</span>`).join('')}</p>`:'';
    const group=g=>{const rows=R[g.id]||[];if(g.optional&&!rows.length)return '';const extra=rows.some(r=>r.extra);return `<div class="rs-bg ${g.cls}" role="group" aria-label="${esc(extra?'AI resources used · extra usage monthly':g.label)}" data-rs-group="${esc(g.id)}"><p class="rs-gh"><b>${esc(g.title)}</b><span>${esc(extra?'week used · extra usage monthly':g.sub)}</span></p>${g.legend?legend():''}${rows.map(row).join('')}</div>`;};
    return `<section class="rs-widget rs-barsw wz-home-widget" data-sig="${esc(sig)}" aria-label="AI and computer resources">${GROUPS.map(group).join('')}</section>`;}
  // The least left across every bar ({label, left} or null): Settings shows it as a quiet value only when it is low.
  function lowest(){const R=homeRows();let low=null;for(const r of GROUPS.flatMap(g=>R[g.id]||[]))if(r.left!=null&&!r.signin&&(!low||r.left<low.left))low={label:r.label,left:r.left,value:/left$/.test(r.value)?r.value:r.value?r.value+' used':''};return low;}
  function paintBars(host,settled){const box=host.querySelector('.rs-barsw'),next=homeBarsHtml();
    const tmp=document.createElement('div');tmp.innerHTML=next;const fresh=tmp.firstElementChild;
    if(!box||box.dataset.sig!==fresh.dataset.sig){host.innerHTML=next;}
    else{const old=[...box.querySelectorAll('.rs-br')],neu=[...fresh.querySelectorAll('.rs-br')];
      old.forEach((b,i)=>{const n=neu[i];if(!n)return;b.setAttribute('aria-label',n.getAttribute('aria-label'));const ov=b.querySelector('.rs-bv'),nv=n.querySelector('.rs-bv');ov.textContent=nv.textContent;ov.className=nv.className;
        const os=b.querySelectorAll('.rs-bs'),ns=n.querySelectorAll('.rs-bs');os.forEach((g,j)=>{g.className=ns[j].className;g.style.flex=ns[j].style.flex;g.title=ns[j].title;g.firstElementChild.dataset.w=ns[j].firstElementChild.dataset.w;});});}
    const fill=()=>{for(const f of host.querySelectorAll('.rs-bf'))f.style.width=Math.max(0,Math.min(100,Number(f.dataset.w)||0))+'%';};
    // Settled: a freshly drawn Settings page shows the readings at once (no grow-from-zero on every re-render).
    if(settled&&!box)fill();else requestAnimationFrame(()=>requestAnimationFrame(fill));}
  function paintDials(host){const specs=dialSpecs(),box=host.querySelector('.rs-dialed');
    if(box&&box.dataset.sig===dialSig(specs)){for(const sp of specs){const el=box.querySelector(`[data-k="${CSS.escape(sp.k)}"]`);if(!el)continue;el.dataset.t=sp.v??'';el.classList.toggle('rs-dial-off',!!(sp.signin||sp.off));if(sp.v!=null){el.setAttribute('role','meter');el.setAttribute('aria-valuenow',sp.v);}el.classList.toggle('rs-empty',!!(sp.fuel&&sp.v!=null&&sp.v<25));el.classList.toggle('rs-crit',!!(sp.fuel&&sp.v!=null&&sp.v<10));if(sp.money){el.dataset.money=sp.money;const bb=el.querySelector('.rs-gauge b');if(bb)bb.textContent=sp.money;}}}
    else host.innerHTML=dialHtml();
    requestAnimationFrame(()=>requestAnimationFrame(()=>settle(host)));}
  // Sweep only what is actually on screen: a hidden or not-yet-shown Home keeps its needles at zero for later.
  const seen=el=>{if(document.hidden||!el.isConnected)return false;const r=el.getBoundingClientRect();return r.width>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&getComputedStyle(el).visibility!=='hidden';};
  function settle(root){let wait=false;for(const el of root.querySelectorAll('.rs-dial[data-k]')){const t=el.dataset.t;if(t===''||t==null)continue;
      const k=el.dataset.k,to=Number(t),a=S.anim[k];
      if(!seen(el)){if(!(k in S.shown)&&!a)wait=true;continue;}
      let run=a&&a.to===to?a:null;
      if(!run){if(!a&&(S.shown[k]??null)===to)continue;const from=cur(k),boot=!(k in S.shown)&&!a;
        run=S.anim[k]={from,to,dur:boot?1400:700,t0:performance.now()+(boot?(Number(el.style.getPropertyValue('--i'))||0)*90:0)};}
      const g=el.querySelector('.rs-gauge'),b=el.querySelector('.rs-gauge b'),left=Math.max(0,run.t0+run.dur-performance.now()),delay=Math.max(0,run.t0-performance.now());
      g.style.setProperty('--d',Math.max(0,left-delay)+'ms');g.style.setProperty('--w',delay+'ms');
      g.style.setProperty('--a',ang(to));g.style.setProperty('--o',100-to);cancelAnimationFrame(el._rsRaf);
      const tick=()=>{if(S.anim[k]!==run){return;}const x=Math.max(0,Math.min(1,(performance.now()-run.t0)/run.dur));if(b&&!el.dataset.money&&!el.classList.contains('rs-dial-off'))b.textContent=Math.round(run.from+(run.to-run.from)*ease(x));
        if(x<1)el._rsRaf=requestAnimationFrame(tick);else{S.shown[k]=run.to;delete S.anim[k];}};
      el._rsRaf=requestAnimationFrame(tick);}
    if(wait){clearTimeout(S.dialWait);S.dialWait=setTimeout(()=>{for(const h of document.querySelectorAll('[data-home-resources]'))settle(h);},400);}}
  function paint() {if(S.pressing)return;for(const h of [...S.extra]){if(h.isConnected)paintBars(h);else S.extra.delete(h);}const hosts=document.querySelectorAll('[data-home-resources]'); for(const host of hosts) {if(ours()){paintBars(host);continue;}const h=html();if(host.innerHTML!==h){const next=document.createElement('div');next.innerHTML=h;const oldZones=host.querySelectorAll('.rs-zone'),newZones=next.querySelectorAll('.rs-zone'),oldA=host.querySelector('.rs-health-alert'),newA=next.querySelector('.rs-health-alert');if(oldZones.length===2&&newZones.length===2&&!!oldA===!!newA){if(oldA){oldA.className=newA.className;oldA.innerHTML=newA.innerHTML;oldA.setAttribute('aria-label',newA.getAttribute('aria-label'));}oldZones.forEach((zone,i)=>{zone.className=newZones[i].className;zone.innerHTML=newZones[i].innerHTML;});}else host.innerHTML=h;}} if(S.panel) {const body=S.panel.querySelector('[data-res-body]'),scroll=body.scrollTop,hadRefreshFocus=body.contains(document.activeElement)&&document.activeElement.hasAttribute('data-usage-refresh');const h=S.tab==='server'?devicesHtml():S.tab==='health'?healthHtml():window.WosUsage?.html()||'<p>AI usage unavailable</p>';if(body.innerHTML!==h){body.innerHTML=h;body.scrollTop=scroll;if(ours())requestAnimationFrame(()=>requestAnimationFrame(()=>settle(body)));if(hadRefreshFocus)body.querySelector('[data-usage-refresh]')?.focus({preventScroll:true});}}}
  async function read(path,signal) {const r=await fetch(path,{cache:'no-store',credentials:'same-origin',signal});if(!r.ok)throw new Error('Unavailable');return r.json();}
  // A Settings › Resources page counts as a viewer too (S.extra), so its bars read fresh while it is open.
  const viewing=()=>active()||(!document.hidden&&([...S.extra].some(h=>h.isConnected)||[...S.watch].some(h=>h.isConnected&&h.getClientRects().length>0&&getComputedStyle(h).visibility!=='hidden')));/* a watched page counts only while it is on screen (a background desk is visibility:hidden) */
  async function update(force=false) {
    if(S.busy)return S.busy;if(!viewing())return;
    const controller=S.controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
    S.busy=(async()=>{const jobs=[];
      if(force||Date.now()-S.serverAt>=14000)jobs.push(read('/api/system/load',controller.signal).then(j=>{const v=normalize(j);if(v.cpu==null&&v.memory==null&&v.disk==null)throw new Error('Unavailable');S.server=v;S.serverAt=Date.now();S.serverError='';}).catch(e=>{if(viewing())S.serverError='Unavailable';}));
      if(force||Date.now()-S.devicesAt>=(S.panel&&S.tab==='server'?14000:60000))jobs.push(read('/api/system/devices',controller.signal).then(j=>{if(!Array.isArray(j?.devices))throw new Error('Unavailable');S.devices=j;S.devicesAt=Date.now();S.devicesError='';}).catch(e=>{if(viewing())S.devicesError='Unavailable';}));
      if(force||Date.now()-S.healthAt>=(S.panel&&S.tab==='health'?14000:60000))jobs.push(read('/api/system/health',controller.signal).then(j=>{if(typeof j?.available!=='boolean')throw new Error('Unavailable');S.health=j;S.healthAt=Date.now();S.healthError='';}).catch(e=>{if(viewing())S.healthError='Unavailable';}));
      if(force||Date.now()-S.aiAt>=60000)jobs.push(read('/wizard/ai-usage',controller.signal).then(j=>{S.ai=window.WosUsage.normalize(j);S.aiAt=Date.now();S.aiError='';window.WosUsage.snap=S.ai;window.WosUsage.at=S.aiAt;window.WosUsage.error='';}).catch(e=>{if(viewing()){S.aiError='Unavailable';window.WosUsage.error='Latest AI usage unavailable';}}));
      await Promise.all(jobs.map(j=>j.then(()=>{if(viewing())paint();})));/* paint as each reading lands: a slow AI read must not hold back a failing health check */
    })().finally(()=>{clearTimeout(timeout);S.busy=null;S.controller=null;schedule();window.dispatchEvent?.(new Event('wos:resources'));});return S.busy;
  }
  function schedule(){clearTimeout(S.timer);S.timer=null;if(viewing())S.timer=setTimeout(()=>{S.timer=null;update();},15000);}
  function sync(){if(!viewing()){clearTimeout(S.timer);S.timer=null;S.controller?.abort();return;}paint();if(!S.busy)update();}
  function close(){if(!S.panel)return false;S.backdrop?.remove();S.backdrop=null;S.panel.remove();S.panel=null;holdInstallPrompt(false);sync();
    /* Back to the exact bar that opened the sheet (a Settings › Resources bar too); else the Home one, as before. */
    const from=S.openerEl;S.openerEl=null;if(from?.isConnected&&from.getClientRects().length){from.focus({preventScroll:true});return true;}
    if(desktopHome()||window.__wos?.idx===0)[...document.querySelectorAll(`[data-res-open="${S.opener}"]`)].find(b=>b.getClientRects().length&&getComputedStyle(b).visibility!=='hidden')?.focus({preventScroll:true});return true;}
  function open(tab){close();S.tab=tab;S.opener=tab;const d=document.createElement('section');d.className='rs-sheet wz-home-popup';d.setAttribute('role','dialog');d.setAttribute('aria-label','Resources');d.setAttribute('aria-modal','true');d.innerHTML=`<header class="rs-detail-head"><button data-res-close aria-label="Back to Home">‹</button><h2>Resources</h2><button data-res-refresh aria-label="Refresh resource readings">↻</button></header><nav class="rs-tabs"><button data-res-tab="server">Devices</button><button data-res-tab="health">Health</button><button data-res-tab="ai">AI accounts</button></nav><div class="rs-detail-body" data-res-body></div>`;(document.querySelector('.device')||document.body).append(d);S.panel=d;holdInstallPrompt(true);backdropFor(d);select(tab);update();d.querySelector('[data-res-close]').focus({preventScroll:true});}
  function select(tab){const was=S.tab;S.tab=tab;S.panel?.querySelectorAll('[data-res-tab]').forEach(b=>{b.classList.toggle('selected',b.dataset.resTab===tab);b.setAttribute('aria-pressed',b.dataset.resTab===tab);});paint();if(tab==='health'&&was!=='health'&&S.panel&&Date.now()-S.healthAt>14000)update();}
  document.addEventListener('click',e=>{const pk=e.target.closest('[data-dvpick]');if(pk){e.preventDefault();S.pick=S.pick===pk.dataset.dvpick?null:pk.dataset.dvpick;paint();return;}const si=e.target.closest('[data-res-signin]');if(si){e.preventDefault();/* A reading that stopped: open the app straight at that sign-in's Reconnect. */const app=si.dataset.resSignin,path=si.hasAttribute('data-res-reconnect')&&RECONNECT_APPS.has(app)?`/${app}/?reconnect=1`:'';if(!window.WizOpenApp?.(app,path))location.assign(path||`/${app}/`);return;}const b=e.target.closest('[data-res-open],[data-res-close],[data-res-tab],[data-res-refresh],.rs-sheet [data-usage-refresh]');if(!b)return;e.preventDefault();if(b.hasAttribute('data-res-open')){open(b.dataset.resOpen);S.openerEl=b;}else if(b.hasAttribute('data-res-close'))close();else if(b.hasAttribute('data-res-tab'))select(b.dataset.resTab);else update(true);});
  // Cover app frames too: a click inside an iframe never bubbles to this document.
  // The transparent scrim stays immediately below the existing Resources panel.
  const backdropFor = panel => {
    const bg = document.createElement('div'); bg.className = 'rs-backdrop';
    panel.before(bg); bg.addEventListener('click', e => { e.preventDefault(); close(); });
    S.backdrop = bg;
  };
  document.addEventListener('pointerdown',e=>{if(e.target.closest('.rs-widget,.rs-sheet'))S.pressing=true;});
  for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>{if(S.pressing)setTimeout(()=>{S.pressing=false;paint();},0);});
  document.addEventListener('keydown',e=>{if(!S.panel)return;if(e.key==='Escape'){e.preventDefault();if(window.__wux)close();else window.__wos?.onBack();}else if(e.key==='Tab'){const list=[...S.panel.querySelectorAll('button:not(:disabled)')],first=list[0],last=list.at(-1);if(e.shiftKey&&(document.activeElement===first||!S.panel.contains(document.activeElement))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||!S.panel.contains(document.activeElement))){e.preventDefault();first?.focus();}}});
  window.addEventListener('blur',()=>{S.pressing=false;});
  document.addEventListener('visibilitychange',sync);
  // Settings › Resources (and any later host): the Home bars, same groups and layout, drawn into a given element and kept
  // live while it stays in the page. Readings older than Home's own cadence are refreshed once.
  function bars(host){if(!host)return;S.extra.add(host);paintBars(host,true);if(!S.busy&&(Date.now()-S.serverAt>14000||Date.now()-S.aiAt>60000||Date.now()-S.devicesAt>60000))update();}
  // A page that shows readings without the bars (Settings › System pages filled by a package) keeps them fresh while shown.
  function watch(el){if(!el)return;for(const h of [...S.watch])if(!h.isConnected)S.watch.delete(h);S.watch.add(el);sync();}
  window.WosResources={bars,barsHtml:()=>homeBarsHtml(),lowest,groups:()=>GROUPS.map(g=>g.id),healthProblems,watch,home(){queueMicrotask(sync);return `<div data-slot="home-top" data-home-resources>${html()}</div>`;},sync,back:close,normalize,weekly,update,extraOf,extraFor,get state(){return {server:S.server,serverAt:S.serverAt,serverError:S.serverError,devices:S.devices,devicesAt:S.devicesAt,devicesError:S.devicesError,health:S.health,healthAt:S.healthAt,healthError:S.healthError,ai:S.ai,aiAt:S.aiAt,aiError:S.aiError,timer:!!S.timer,busy:!!S.busy,panel:!!S.panel};}};
})();
