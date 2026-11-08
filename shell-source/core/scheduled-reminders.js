/* Snooze: hand a thread, or one message in it, back to yourself at a set time. Shared by phone and desktop.
 * Timing, storage and delivery are the one Wizard scheduler (/wizard/v1/schedules, kind "return"): it never runs
 * a prompt. When it fires, the thread comes back to the top of Ready with a banner, the phone's reply watcher posts
 * a notification for the watch id wzb_<schedule id>, and an open desktop shows a system notification.
 * Picker design: Novaire (wizard-ux #255); prompt and exact-time confirmation: Novaire (#355). */
(() => {
  'use strict';
  const API='/wizard/v1/schedules', J={'Content-Type':'application/json'}, WATCH='wzb_', SEEN_STORE='wos.boomerang.seen.v1';
  const zoneNow=()=>{try{return window.WizConfig?.timeZone?.()||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch{return 'UTC'}};
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAYS=['Su','Mo','Tu','We','Th','Fr','Sa'];
  const PRESETS=[
    ['today','Later today'],['tomorrow-am','Tomorrow'],['2d','In 2 days'],['3d','In 3 days'],['5d','In 5 days'],['1w','Next week']
  ];
  let reminders=[], loaded=false, sheet=null, listeners=new Set(), poll=0, restoreFocus=null;
  const focused=new Set(), watchedAt=new Map();
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad=n=>String(n).padStart(2,'0');
  const dateString=(y,m,d)=>`${y}-${pad(m)}-${pad(d)}`;
  const parseDate=s=>{const [y,m,d]=String(s).split('-').map(Number);return{y,m,d}};
  const daysInMonth=(y,m)=>new Date(Date.UTC(y,m,0)).getUTCDate();
  function addWallDays(date,n){const {y,m,d}=parseDate(date),v=new Date(Date.UTC(y,m-1,d+n));return dateString(v.getUTCFullYear(),v.getUTCMonth()+1,v.getUTCDate())}
  function addWallMonths(date,n){const {y,m,d}=parseDate(date),v=new Date(Date.UTC(y,m-1+n,1));return dateString(v.getUTCFullYear(),v.getUTCMonth()+1,Math.min(d,daysInMonth(v.getUTCFullYear(),v.getUTCMonth()+1)))}
  const validZone=z=>{try{new Intl.DateTimeFormat('en',{timeZone:z}).format();return Boolean(z)}catch{return false}};
  const zones=()=>[zoneNow(),Intl.DateTimeFormat().resolvedOptions().timeZone,'UTC','America/New_York','Europe/London'].filter((z,i,a)=>validZone(z)&&a.indexOf(z)===i);
  const zoneOptions=selected=>zones().map(z=>`<option value="${esc(z)}"${z===selected?' selected':''}>${esc(z)}</option>`).join('');
  const req=async(path,init={})=>{const r=await fetch(path,{cache:'no-store',credentials:'same-origin',...init});let p={};try{p=await r.json()}catch{}if(!r.ok)throw new Error(r.status===404?'This Wizard needs an update for Snooze.':p.error?.message||p.error||`HTTP ${r.status}`);return p};
  // A scheduler job of kind "return", in the picker's own shape.
  const fromJob=j=>({id:j.id,session_id:j.thread,created_at:j.createdAt||null,due_at:j.when?.once||j.nextRun,timezone:validZone(j.timezone)?j.timezone:zoneNow(),note:j.prompt||'',
    anchor_at:j.target?.message??null,target_kind:j.target?.message!=null?'message':'thread',context:j.target?.excerpt||String(j.name||'').replace(/^(?:Boomerang|Snooze) · /,''),
    status:j.lastRun?.outcome==='returned'&&Date.parse(j.lastRun.scheduledFor)===Date.parse(j.when?.once||'')?'due':'scheduled',returned_at:j.lastRun?.finishedAt||null});
  const seen=()=>{try{return new Set(JSON.parse(localStorage.getItem(SEEN_STORE)||'[]'))}catch{return new Set()}};
  const markSeen=ids=>{try{localStorage.setItem(SEEN_STORE,JSON.stringify([...ids].slice(-200)))}catch{}};
  const DEV=()=>{const d=window.WizardOSDevice;return d&&typeof d.watchRun==='function'?d:null};
  const live=()=>window.WizLive||null;
  const titleOf=r=>live()?.session?.(r.session_id)?.title||r.context||'Snooze';
  const openThread=sid=>{const href=location.pathname+'?session='+encodeURIComponent(sid);if(!window.WizCore?.deeplink?.route(href))location.href=href};
  /* The phone app's reply watcher polls /wizard/hermes/v1/runs/wzb_<id>; the scheduler answers "completed" once the
   * thread is back, and the watcher notifies with a tap that opens the thread. Re-armed while the app is used, so a
   * long Boomerang stays inside the watcher's window, and never over a thread whose own reply is still due. */
  function arm(r,force=false){
    const d=DEV();if(!d||typeof d.watchRun!=='function'||r.status!=='scheduled')return;
    const s=live()?.session?.(r.session_id);if(!force&&s&&['submitting','queued','running','stopping','waiting_for_approval'].includes(s.status))return;
    if(!force&&Date.now()-(watchedAt.get(r.id)||0)<30*60000)return;
    try{d.watchRun(r.session_id,WATCH+r.id,('◷ Snooze · '+titleOf(r)).slice(0,60));watchedAt.set(r.id,Date.now())}catch{}
  }
  // Something came back: bring an archived or deferred thread back to Ready, and tell the owner on this screen.
  function arrived(list){
    const before=seen(),fresh=list.filter(r=>r.status==='due'&&!before.has(r.id));
    if(!fresh.length)return;
    for(const r of fresh){
      before.add(r.id);
      const s=live()?.session?.(r.session_id);if(s&&(s.archived||s.deferred))void live().restore?.(r.session_id);
      if(!loaded)continue; // already back before this page opened: the banner and Ready place say it
      const text=r.note||r.context||'Back for you';
      try{window.dispatchEvent(new CustomEvent('wos:boomerang-back',{detail:{id:r.id,session:r.session_id,title:titleOf(r)}}))}catch{}
      if(!DEV()&&typeof Notification==='function'&&Notification.permission==='granted'){
        try{const n=new Notification('◷ Snooze · '+titleOf(r),{body:text,tag:'wzb-'+r.id});n.onclick=()=>{try{window.focus()}catch{}openThread(r.session_id);n.close()}}catch{}
      }
    }
    markSeen(before);
  }
  const askNotify=()=>{try{if(!DEV()&&typeof Notification==='function'&&Notification.permission==='default')void Notification.requestPermission()}catch{}};
  const emit=()=>{listeners.forEach(fn=>{try{fn(reminders)}catch{}});window.dispatchEvent(new Event('wos:boomerang'))};
  // A Snooze set before it took threads out of the list (or by an older client) still does, once: only while
  // nothing happened in the thread since it was set (no message from James, no Restore).
  const adopted=new Set();
  function adopt(list){const L=live();if(!L?.ok||!L.defer)return;for(const r of list){const t=Date.parse(r.created_at);if(r.status!=='scheduled'||!isFinite(t)||adopted.has(r.id))continue;const s=L.session?.(r.session_id);if(!s||s.archived||s.deferred||L.busy?.(s.id))continue;adopted.add(r.id);if(Date.parse(s.lastUserAt)>t||Date.parse(s.restoredAt)>t)continue;void L.defer(s.id)}}
  async function refresh(){try{const p=await req(API);const list=(Array.isArray(p.schedules)?p.schedules:[]).filter(j=>j.kind==='return').map(fromJob);arrived(list);reminders=list;loaded=true;adopt(list);reminders.forEach(r=>arm(r));emit();return reminders}catch{return reminders}}
  const forSession=id=>reminders.filter(r=>r.session_id===id);
  const dueFor=id=>forSession(id).filter(r=>r.status==='due');
  const nextFor=id=>forSession(id).filter(r=>r.status==='scheduled').sort((a,b)=>Date.parse(a.due_at)-Date.parse(b.due_at))[0]||null;
  const parts=(t=Date.now(),z=zoneNow())=>{const p={};for(const x of new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t)))p[x.type]=x.value;return{y:+p.year,m:+p.month,d:+p.day,h:+p.hour%24,min:+p.minute}};
  function offsetAt(t,z){const p={};for(const x of new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t)))p[x.type]=x.value;return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour%24,+p.minute,+p.second)-Math.floor(t/1000)*1000}
  function wallToUtc(date,time,z=zoneNow()){
    const {y,m,d}=parseDate(date),[h,min]=time.split(':').map(Number);if(!validZone(z))throw new Error('Choose a valid timezone.');let guess=Date.UTC(y,m-1,d,h,min);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time)||m<1||m>12||d<1||d>daysInMonth(y,m)||h<0||h>23||min<0||min>59||!Number.isFinite(guess))throw new Error('Choose a real date and time.');
    for(let i=0;i<4;i++)guess=Date.UTC(y,m-1,d,h,min)-offsetAt(guess,z);
    const check=parts(guess,z);if(check.y!==y||check.m!==m||check.d!==d||check.h!==h||check.min!==min)throw new Error('That local time does not exist in this timezone.');
    return new Date(guess).toISOString();
  }
  function preset(kind,z=zoneNow(),now=Date.now()){
    const p=parts(now,z),today=dateString(p.y,p.m,p.d);
    if(kind==='today'){const min=Math.min(23*60+59,p.h*60+p.min+240);return{date:today,time:`${pad(Math.floor(min/60))}:${pad(min%60)}`}}
    if(/^[124]h$/.test(kind)){const h=Number(kind[0]),q=parts(now+h*3600000,z);return{date:dateString(q.y,q.m,q.d),time:`${pad(q.h)}:${pad(q.min)}`}}
    if(kind==='tomorrow-am')return{date:addWallDays(today,1),time:'09:00'};
    if(kind==='tomorrow-pm')return{date:addWallDays(today,1),time:'14:00'};
    if(kind==='1m')return{date:addWallMonths(today,1),time:'09:00'};
    const n={ '2d':2,'3d':3,'4d':4,'5d':5,'1w':7,'2w':14 }[kind]||1;return{date:addWallDays(today,n),time:'09:00'};
  }
  function formatPreset(v,z){const utc=wallToUtc(v.date,v.time,z);return new Intl.DateTimeFormat('en',{timeZone:z,weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(utc))}
  function presetButtons(z,selected=''){return PRESETS.map(([id,label])=>{const v=preset(id,z);return `<button type="button" data-boom-preset="${id}" class="${selected===`${v.date}T${v.time}`?'selected':''}"${Date.parse(wallToUtc(v.date,v.time,z))<=Date.now()?' disabled':''}><span>${label}</span><small>${esc(formatPreset(v,z))}</small></button>`}).join('')+'<button type="button" data-boom-someday><span>Someday</span><small>No time · bottom of Ready</small></button><button type="button" data-boom-exact><span>Other date…</span><small>Pick an exact date &amp; time</small></button>'}
  function years(selected){const now=new Date().getUTCFullYear(),from=Math.min(now-2,selected),to=Math.max(now+10,selected);let html='';for(let y=from;y<=to;y++)html+=`<option value="${y}"${y===selected?' selected':''}>${y}</option>`;return html}
  function calendarHtml(selected){const {y,m,d}=parseDate(selected);return `<section class="boom-calendar" data-boom-calendar hidden aria-label="Choose date"><div class="boom-cal-head"><button type="button" data-cal-prev aria-label="Previous month">‹</button><select name="cal-month" aria-label="Month">${MONTHS.map((x,i)=>`<option value="${i+1}"${i+1===m?' selected':''}>${x}</option>`).join('')}</select><select name="cal-year" aria-label="Year">${years(y)}</select><button type="button" data-cal-next aria-label="Next month">›</button></div><div class="boom-weekdays" aria-hidden="true">${WEEKDAYS.map(x=>`<span>${x}</span>`).join('')}</div><div class="boom-grid" role="grid" aria-label="${MONTHS[m-1]} ${y}" data-cal-grid data-year="${y}" data-month="${m}"></div></section>`}
  function renderCalendar(form,focusDate=''){
    const grid=form.querySelector('[data-cal-grid]'),y=+form.elements['cal-year'].value,m=+form.elements['cal-month'].value,selected=form.date.value,today=(()=>{const p=parts(Date.now(),form.timezone.value);return dateString(p.y,p.m,p.d)})();
    grid.dataset.year=y;grid.dataset.month=m;grid.setAttribute('aria-label',`${MONTHS[m-1]} ${y}`);grid.innerHTML='';
    for(let i=0;i<new Date(Date.UTC(y,m-1,1)).getUTCDay();i++)grid.insertAdjacentHTML('beforeend','<span aria-hidden="true"></span>');
    for(let d=1;d<=daysInMonth(y,m);d++){const value=dateString(y,m,d),chosen=value===selected,disabled=value<today;grid.insertAdjacentHTML('beforeend',`<button type="button" role="gridcell" data-cal-day="${value}" aria-selected="${chosen}"${disabled?' disabled':''} tabindex="${chosen||(!selected.startsWith(`${y}-${pad(m)}`)&&value===today)?'0':'-1'}">${d}</button>`)}
    const target=focusDate&&grid.querySelector(`[data-cal-day="${focusDate}"]`);if(target){target.tabIndex=0;target.focus()}
  }
  function shiftCalendar(form,months){let y=+form.elements['cal-year'].value,m=+form.elements['cal-month'].value+months;if(m<1){m=12;y--}if(m>12){m=1;y++}form.elements['cal-year'].innerHTML=years(y);form.elements['cal-year'].value=String(y);form.elements['cal-month'].value=String(m);renderCalendar(form)}
  function close(){if(!sheet)return false;const old=sheet;sheet=null;old.remove();restoreFocus?.focus?.({preventScroll:true});restoreFocus=null;return true}
  function back(){return close()?'boomerang':false}
  // Exact owner-zone time, shared by confirmation and the persistent banner (idea: Novaire #355).
  function returnLabel(r){const p=parts(Date.parse(r.due_at),r.timezone),date=new Intl.DateTimeFormat('en-GB',{timeZone:r.timezone,day:'numeric',month:'short'}).format(new Date(r.due_at));return `Back ${date} at ${p.h}:${pad(p.min)}`}
  // Someday is the existing Defer operation: no timer and no change to existing return jobs.
  // opts.restore (tweak one-tap Snooze only): an archived thread is restored first so it lands in Ready.
  async function someday(opts){
    if(!live()?.defer)throw new Error('Snooze is still loading.');
    const restored=opts.restore&&live().session?.(opts.sessionId)?.archived;
    if(restored&&!await live().restore?.(opts.sessionId))throw new Error('Could not snooze · thread kept where it was.');
    if(!await live().defer(opts.sessionId))throw new Error(restored?'Could not snooze · thread restored to Ready.':'Could not snooze · thread kept where it was.');
    close();window.dispatchEvent(new CustomEvent('wos:snooze-someday',{detail:{session:opts.sessionId}}));
  }
  // A timed Snooze also takes the thread out of the list (James, 23 Oct 2026): the existing Defer disposition, restored when it comes back.
  async function away(id){const s=live()?.session?.(id);if(!s||s.archived)return;if(!s.deferred&&!await live().defer?.(id)){window.dispatchEvent(new CustomEvent('wos:boomerang-error'));return}window.dispatchEvent(new CustomEvent('wos:snooze-someday',{detail:{session:id,quiet:true}}))}
  function open(opts,existing=null){
    close();restoreFocus=document.activeElement;const selectedZone=validZone(existing?.timezone)?existing.timezone:zoneNow(),ep=existing?parts(Date.parse(existing.due_at),selectedZone):null,p=existing?{date:dateString(ep.y,ep.m,ep.d),time:`${pad(ep.h)}:${pad(ep.min)}`}:preset('tomorrow-am',selectedZone),hasNote=Boolean(existing?.note||opts.note);
    sheet=document.createElement('div');sheet.className='boom-sheet';sheet.innerHTML=`<form class="boom-card" data-boom-form role="dialog" aria-modal="true" aria-labelledby="boom-title"><header><span aria-hidden="true">◷</span><b id="boom-title">When should this come back?</b><button type="button" data-boom-close aria-label="Close">×</button></header>${opts.targetKind==='message'&&opts.context?`<q class="boom-context">${esc(opts.context)}</q>`:''}<section class="boom-quick" aria-label="Snooze until"><div class="boom-presets">${presetButtons(selectedZone,existing?`${p.date}T${p.time}`:'')}</div></section><section class="boom-exact" aria-labelledby="boom-exact-title" hidden><h3 id="boom-exact-title">Exact date &amp; time</h3><div class="boom-fields"><label>Date<span class="boom-date-control"><input required type="date" name="date" value="${p.date}"><button type="button" data-boom-calendar-toggle aria-expanded="false" aria-label="Open calendar">▣</button></span></label><label>Time<input required type="time" name="time" value="${p.time}" step="60"></label></div>${calendarHtml(p.date)}<label class="boom-zone">Timezone<select required name="timezone">${zoneOptions(selectedZone)}</select><small>Your phone’s time zone by default · saved as UTC</small></label></section><button type="button" class="boom-link" data-boom-note-toggle aria-expanded="${hasNote}">${hasNote?'Hide note':'＋ Add a note'}</button><label class="boom-note"${hasNote?'':' hidden'}>Note<input name="note" maxlength="500" value="${esc(existing?.note||opts.note||'')}" placeholder="What should Future You remember?"></label><p class="boom-error" role="alert"></p><footer${existing?'':' hidden'}>${existing?'<button type="button" class="danger" data-boom-cancel>Remove snooze</button>':''}<button type="submit" class="primary">${existing?'Save':'Snooze'}</button></footer></form>`;
    document.body.append(sheet);const form=sheet.querySelector('form'),calendar=form.querySelector('[data-boom-calendar]'),toggle=form.querySelector('[data-boom-calendar-toggle]');renderCalendar(form);
    let saving=false;
    const refreshPresets=()=>{form.querySelector('.boom-presets').innerHTML=presetButtons(form.timezone.value,`${form.date.value}T${form.time.value}`)};
    sheet.addEventListener('click',async e=>{
      if(e.target.closest('[data-boom-someday]')){if(saving)return;saving=true;const button=e.target.closest('button');button.disabled=true;try{await someday(opts)}catch(err){form.querySelector('.boom-error').textContent=err.message;button.disabled=false}finally{saving=false}return}
      if(e.target.closest('[data-boom-exact]')){form.querySelector('.boom-exact').hidden=false;form.querySelector('footer').hidden=false;form.querySelectorAll('[data-boom-preset]').forEach(b=>b.classList.remove('selected'));form.date.focus();return}
      const pre=e.target.closest('[data-boom-preset]');if(pre){const v=preset(pre.dataset.boomPreset,form.timezone.value);form.date.value=v.date;form.time.value=v.time;form.querySelectorAll('[data-boom-preset]').forEach(b=>b.classList.toggle('selected',b===pre));renderCalendar(form);form.requestSubmit();return} // one tap snoozes
      if(e.target.closest('[data-boom-calendar-toggle]')){calendar.hidden=!calendar.hidden;toggle.setAttribute('aria-expanded',String(!calendar.hidden));if(!calendar.hidden){const v=parseDate(form.date.value);form.elements['cal-month'].value=String(v.m);form.elements['cal-year'].innerHTML=years(v.y);form.elements['cal-year'].value=String(v.y);renderCalendar(form);form.elements['cal-month'].focus()}return}
      if(e.target.closest('[data-cal-prev]')){shiftCalendar(form,-1);return}if(e.target.closest('[data-cal-next]')){shiftCalendar(form,1);return}
      const day=e.target.closest('[data-cal-day]');if(day){form.date.value=day.dataset.calDay;renderCalendar(form);calendar.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();return}
      const nt=e.target.closest('[data-boom-note-toggle]');if(nt){const note=form.querySelector('.boom-note');note.hidden=!note.hidden;nt.setAttribute('aria-expanded',String(!note.hidden));nt.textContent=note.hidden?'＋ Add a note':'Hide note';if(!note.hidden)form.note.focus();return}
      if(e.target.closest('[data-boom-close]')||e.target===sheet){e.stopPropagation();close();return}if(e.target.closest('[data-boom-cancel]')){e.stopPropagation();void cancel(existing.id)}
    },true);
    form.addEventListener('change',e=>{if(e.target.name==='timezone'){refreshPresets();renderCalendar(form)}if(e.target.name==='date'){const v=parseDate(form.date.value);form.elements['cal-month'].value=String(v.m);form.elements['cal-year'].innerHTML=years(v.y);form.elements['cal-year'].value=String(v.y);renderCalendar(form)}if(e.target.name==='cal-month'||e.target.name==='cal-year')renderCalendar(form)});
    form.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return}
      if(e.key==='Tab'){const fs=[...form.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(x=>x.offsetParent!==null),a=fs[0],b=fs.at(-1);if(e.shiftKey&&document.activeElement===a){e.preventDefault();b.focus()}else if(!e.shiftKey&&document.activeElement===b){e.preventDefault();a.focus()}return}
      const day=e.target.closest?.('[data-cal-day]');if(!day||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))return;e.preventDefault();const move={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[e.key],current=day.dataset.calDay;let next=current;if(move)next=addWallDays(current,move);else if(e.key==='Home')next=addWallDays(current,-new Date(`${current}T00:00:00Z`).getUTCDay());else if(e.key==='End')next=addWallDays(current,6-new Date(`${current}T00:00:00Z`).getUTCDay());else next=addWallMonths(current,e.key==='PageUp'?-1:1);const v=parseDate(next);form.elements['cal-month'].value=String(v.m);form.elements['cal-year'].innerHTML=years(v.y);form.elements['cal-year'].value=String(v.y);renderCalendar(form,next)
    });
    form.onsubmit=async e=>{e.preventDefault();const error=form.querySelector('.boom-error'),submit=form.querySelector('[type=submit]');error.textContent='';if(submit.disabled||saving)return;saving=true;submit.disabled=true;try{const timezone=form.timezone.value,due_at=wallToUtc(form.date.value,form.time.value,timezone);if(Date.parse(due_at)<=Date.now())throw new Error('Choose a future date and time.');const note=form.note.value.trim().slice(0,500);let job;
      if(existing)job=await req(`${API}/${encodeURIComponent(existing.id)}`,{method:'PATCH',headers:J,body:JSON.stringify({when:{once:due_at},timezone,prompt:note,enabled:true})});
      else{const message=opts.targetKind==='message'&&Number(opts.anchorAt)>0?Number(opts.anchorAt):null,ag=live()?.agentOf?.(opts.sessionId)||'';
        job=await req(API,{method:'POST',headers:J,body:JSON.stringify({name:('Snooze · '+String(opts.title||opts.context||'Thread').replace(/\s+/g,' ').trim()).slice(0,150),kind:'return',when:{once:due_at},timezone,thread:opts.sessionId,prompt:note,...(/^[a-z][a-z0-9-]{0,30}$/.test(ag)&&ag!=='hermes'?{agent:ag}:{}),target:{message,excerpt:message?String(opts.context||'').slice(0,280):''}})})}
      askNotify();const r=fromJob(job);reminders=reminders.filter(x=>x.id!==r.id).concat(r);if(existing){const k=seen();k.delete(r.id);markSeen(k)}arm(r,true);emit();close();void refresh();window.dispatchEvent(new CustomEvent('wos:boomerang-set',{detail:{session:opts.sessionId,at:r.due_at,zone:r.timezone,label:returnLabel(r)}}));void away(opts.sessionId)}catch(err){error.textContent=err.message||'Could not snooze';submit.disabled=false}finally{saving=false}};
    form.querySelector('[data-boom-close]').focus();
  }
  async function cancel(id){const sid=reminders.find(r=>r.id===id)?.session_id;await req(`${API}/${encodeURIComponent(id)}`,{method:'DELETE'});reminders=reminders.filter(r=>r.id!==id);emit();close();void refresh();const s=sid&&live()?.session?.(sid);if(s?.deferred&&!s.archived&&!nextFor(sid))void live().restore?.(sid)} // no snooze left: back in the list
  // Done with a returned Boomerang: the schedule is removed (it fired once; nothing else refers to it).
  const acknowledge=id=>cancel(id);
  
  // The returned message Boomerang this thread should scroll to on its next open (once per page life).
  const focusFor=sessionId=>dueFor(sessionId).find(r=>r.anchor_at!=null&&!focused.has(r.id))||null;
  const focusedOn=id=>{focused.add(id)};
  const when=r=>{try{return new Date(r.due_at).toLocaleString([],{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:r.timezone})}catch{return ''}};
  const zoneName=z=>String(z||'').split('/').pop().replace(/_/g,' ');
  function banner(sessionId){const due=dueFor(sessionId),next=nextFor(sessionId);if(!due.length&&!next)return'';const r=due[0]||next,isDue=Boolean(due.length);
    const what=r.target_kind==='message'?`<q>${esc(String(r.context||'').slice(0,140))}</q>`:'';
    return `<aside class="boom-banner${isDue?' due':''}" data-boom-id="${esc(r.id)}" role="status"><span class="boom-banner-ic" aria-hidden="true">◷</span><span class="boom-banner-tx"><b>${isDue?'Back for you':'Snoozed'}</b>${r.note?`<small>${esc(r.note)}</small>`:''}${what}<time>${esc(returnLabel(r))} · ${esc(zoneName(r.timezone))}</time></span><span class="boom-banner-acts">${isDue&&r.anchor_at!=null?'<button type="button" data-boom-open>Show message</button>':''}${isDue?'<button type="button" data-boom-change>Again</button><button type="button" class="primary" data-boom-done>Done</button>':'<button type="button" data-boom-change>Change</button><button type="button" data-boom-cancel>Cancel</button>'}</span></aside>`}
  async function handle(target,showMessage){const box=target.closest('[data-boom-id]'),id=box?.dataset.boomId,r=reminders.find(x=>x.id===id);if(!r)return false;
    if(target.closest('[data-boom-open]')){showMessage?.(r);return true}
    if(target.closest('[data-boom-change]')){open({sessionId:r.session_id,targetKind:r.target_kind,anchorAt:r.anchor_at,context:r.context,note:r.note,title:titleOf(r)},r);return true}
    try{if(target.closest('[data-boom-done]')){await acknowledge(id);return true}if(target.closest('[data-boom-cancel]')){await cancel(id);return true}}catch{window.dispatchEvent(new CustomEvent('wos:boomerang-error'))}
    return false}
  function start(){if(poll)return;void refresh();poll=setInterval(refresh,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh()});addEventListener('focus',()=>void refresh())}
  window.WosBoomerang={someday,start,refresh,open,close,back,banner,handle,dueFor,nextFor,forSession,focusFor,focusedOn,_returnLabel:returnLabel,_preset:preset,isOpen:()=>Boolean(sheet),_wallToUtc:wallToUtc,_addWallDays:addWallDays,_addWallMonths:addWallMonths,_daysInMonth:daysInMonth,_fromJob:fromJob,onChange(fn){listeners.add(fn);return()=>listeners.delete(fn)}};start();
})();
