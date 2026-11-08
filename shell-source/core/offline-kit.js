/* WizOffline v1: opt-in app replica and durable ordered outbox. No timers reload
 * pages, no origin-wide cache reads/deletes, no external or model transports.
 * project(state, item) and reconcile(state, result, item) are pure app adapters.
 * Each queued write needs server-side idempotency for a lost-response retry. */
(() => {
  'use strict';
  // Presentation belongs in the app's existing replica, not a new database.
  function openReplica(prefix) {
    if(!/^[a-z][a-z0-9-]*-$/.test(prefix))throw Error('App cache prefix required');
    return new Promise((resolve,reject)=>{
      const r=indexedDB.open(prefix+'offline-v1',1);
      r.onupgradeneeded=()=>{r.result.createObjectStore('outbox',{keyPath:'seq',autoIncrement:true});r.result.createObjectStore('meta')};
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
      r.onblocked=()=>reject(Error('Storage blocked'));
    });
  }
  function strictTransaction(db,name) {
    // Older engines may silently ignore transaction options. Never call that saved.
    const tx=db.transaction(name,'readwrite',{durability:'strict'});
    if(tx.durability!=='strict'){tx.abort();throw Error('Crash-durable storage unavailable')}
    return tx;
  }
  function presentation({prefix,slot,initial,onFailure}) {
    if(typeof slot!=='string'||slot.length>512)throw Error('Presentation slot required');
    const dbp=openReplica(prefix), storageKey='presentation:'+slot;
    let value,revision=0,chain=Promise.resolve(),failed=false;
    function validate(v) {
      if(!v||v.v!==1||!Number.isSafeInteger(v.revision)||v.revision<0||!v.positions||typeof v.positions!=='object'||Array.isArray(v.positions))throw Error('Invalid presentation');
      const entries=Object.entries(v.positions);
      if(entries.length>80||entries.some(([k,n])=>k.length>1500||!Number.isFinite(n)||n<0||n>1))throw Error('Invalid reading fraction');
      if(v.route!==null&&(!v.route||v.route.v!==1||typeof v.route.href!=='string'||typeof v.route.base!=='string'))throw Error('Invalid presentation route');
      return v;
    }
    function failure(e){failed=true;onFailure?.(e);throw e}
    const ready=(async()=>{
      const db=await dbp;
      const saved=await new Promise((resolve,reject)=>{
        const tx=db.transaction('meta','readonly'),req=tx.objectStore('meta').get(storageKey);let result;
        req.onsuccess=()=>{result=req.result};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Storage unavailable'));
      });
      // Only migrate the synchronous cache when there is NO authoritative journal.
      value=structuredClone(validate(saved===undefined?{v:1,revision:0,route:null,positions:{},...initial()}:saved));
      revision=value.revision;return structuredClone(value);
    })().catch(failure);
    ready.catch(()=>{});
    function commit(change) {
      // The host awaits ready BEFORE mounting: late boot reads cannot win a write.
      if(!value||failed)return Promise.reject(Error('Presentation storage not ready'));
      const positions={...value.positions};
      for(const [k,n] of Object.entries(change.positions||{})){delete positions[k];if(n!==null)positions[k]=n}
      const next=structuredClone(validate({...value,...change,positions:Object.fromEntries(Object.entries(positions).slice(-80)),revision:++revision}));
      value=next;
      const result=chain.then(async()=>{
        const db=await dbp;
        return new Promise((resolve,reject)=>{
          const tx=strictTransaction(db,'meta');
          const store=tx.objectStore('meta'),check=store.get(storageKey);
          check.onsuccess=()=>{
            if(check.result && check.result.revision >= next.revision){tx.abort();return}
            store.put(next,storageKey);
          };
          tx.oncomplete=()=>resolve(next.revision);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Storage unavailable'));
        });
      }).catch(failure);
      // A failed commit cannot be concealed by a later success.
      chain=result;return result;
    }
    return Object.freeze({ready,commit,flush:()=>chain,snapshot:()=>value&&structuredClone(value)});
  }
  function create(c) {
    if(!/^[a-z][a-z0-9-]*-$/.test(c.prefix))throw Error('App cache prefix required');
    const base=new URL(c.base||'./',location.href), absolute=p=>new URL(p,base).href;
    const dbp=openReplica(c.prefix);
    async function store(name,mode,fn) {
      const db=await dbp;return new Promise((resolve,reject)=>{
        const tx=mode==='readwrite'&&c.crashDurable?strictTransaction(db,name):db.transaction(name,mode);let result;
        const req=fn(tx.objectStore(name));if(req)req.onsuccess=()=>{result=req.result};
        tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Storage unavailable'));
      });
    }
    const all=()=>store('outbox','readonly',s=>s.getAll());
    const meta=()=>store('meta','readonly',s=>s.get('state'));
    const save=s=>store('meta','readwrite',o=>o.put(s,'state'));
    // Every reconciled write bumps the generation; a snapshot fetched across one is stale and is dropped.
    const generation=()=>store('meta','readonly',s=>s.get('gen')).then(g=>g||0);
    const reconciled=s=>store('meta','readwrite',o=>{o.put(s,'state');const g=o.get('gen');g.onsuccess=()=>o.put((g.result||0)+1,'gen')});
    const write=i=>store('outbox','readwrite',s=>s.put(i));
    const remove=i=>store('outbox','readwrite',s=>s.delete(i.seq));
    const lock=fn=>navigator.locks?navigator.locks.request(c.prefix+'outbox',fn):serial(fn);
    let chain=Promise.resolve();function serial(fn){const p=chain.catch(()=>{}).then(fn);chain=p;return p}
    let warming=false, ready=false, warmingError='', done=0,total=0, syncing=false, lastError='';
    const channel=typeof BroadcastChannel==='function'?new BroadcastChannel(c.prefix+'offline'):null;
    async function status() {
      const items=await all();return {online:navigator.onLine,ready,done,total,warming,error:warmingError||lastError,
        pending:items.filter(i=>!i.error).length,failed:items.filter(i=>i.error)};
    }
    async function notify(broadcast=true) {
      const s=await status();c.onStatus?.(s);if(broadcast)channel?.postMessage('changed');return s;
    }
    channel?.addEventListener('message',()=>notify(false).catch(()=>{}));
    const onlineOnly=p=>(c.onlineOnly||[]).some(x=>absolute(p).startsWith(absolute(x)));
    const queueable=p=>(c.writes||[]).some(x=>absolute(p)===absolute(x));
    // Only an explicit JSON 4xx rejection is permanent. A redirect, 401/403 or a non-JSON answer (a login page
    // after the session expired) means "sign in again": the row stays pending and replays after sign-in.
    async function response(p,body,id,timeout=c.timeout||20000) {
      const r=await fetch(absolute(p),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json',...(id?{'X-Wizard-Offline-Id':id}:{})}:{},
        body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(timeout)});
      if(r.redirected||r.status===401||r.status===403)throw Object.assign(Error('Sign in to sync'),{status:r.status,auth:true});
      let d;try{d=await r.json()}catch{throw Object.assign(Error('Invalid server response'),{status:r.status,transient:true})}
      if(!r.ok)throw Object.assign(Error(d?.error||'Unable to connect'),{status:r.status});return d;
    }
    const permanent=e=>!!e.status&&!e.auth&&!e.transient&&e.status>=400&&e.status<500&&![408,429].includes(e.status);
    const projected=async()=>{let state=await meta();for(const i of await all())state=c.project(state,i);return state};
    async function flushLocked(target) {
      if(!navigator.onLine)return;
      syncing=true;
      let target_;
      try {
        for(const queued of await all()) {
          const item=await store('outbox','readonly',s=>s.get(queued.seq));if(!item)continue;
          // A failed operation blocks its dependents, not unrelated later reading work.
          if(item.error)continue;
          if(c.blocked?.(item,await all()))continue;
          try {
            const result=await response(item.path,item.body,item.id);
            const alias=c.alias?.(item,result);if(alias)await store('meta','readwrite',s=>s.put(alias.to,'alias:'+alias.from));
            let state=await meta();state=c.reconcile(state,result,item);await reconciled(state);
            if(c.resolve)for(const later of await all())if(later.seq>item.seq){const changed=c.resolve(later,item,result);if(changed)await write(changed)}
            await remove(item);lastError='';if(item.id===target)target_={result};
            channel?.postMessage('changed');
          } catch(e) {
            if(!permanent(e)){lastError=e.auth||e.transient?'Sign in to sync — your changes are saved on this device.':navigator.onLine?'Waiting to sync — your changes are saved on this device.':'';break}
            item.error=e.message||'Couldn’t save';await write(item);c.onFailure?.(item);if(item.id===target)throw e;
          }
        }
      } finally {syncing=false;await notify()}
      // {result} even when the server's JSON answer is falsy (null, false, 0).
      return target_;
    }
    async function flush(){return lock(async()=>{const before=await all();await flushLocked();if(before.some(i=>!i.error))c.onSynced?.(await projected())}).catch(e=>{lastError=e.message;return notify()})}
    // Recover a permanently failed row: retry it as is (after fixing its cause), or drop it.
    async function retry(seq){return lock(async()=>{const item=await store('outbox','readonly',s=>s.get(seq));if(!item)return false;delete item.error;await write(item);await flushLocked();return true})}
    async function discard(seq){return lock(async()=>{const item=await store('outbox','readonly',s=>s.get(seq));if(!item)return false;await remove(item);await notify();c.onSynced?.(await projected());return true})}
    async function request(path,body,timeout) {
      if(onlineOnly(path)&&!navigator.onLine)throw Error('Needs a connection');
      if(body&&queueable(path))return lock(async()=>{
        // Store before the first network attempt: a killed tab cannot lose an accepted edit.
        const id=crypto.randomUUID();let item={id,path,body:structuredClone(body),created:new Date().toISOString(),tempId:-(Date.now()*1000+Math.floor(Math.random()*1000))};
        if(c.prepare)item=await c.prepare(item,old=>store('meta','readonly',s=>s.get('alias:'+old)));
        item.seq=await store('outbox','readwrite',s=>s.add(item));await notify();
        const done=await flushLocked(id);
        if(done)return done.result;
        const state=await projected();return c.queuedResult(state,item);
      });
      const snapshot=!body&&(c.data||[]).includes(path), gen=snapshot?await generation():0;
      const result=await response(path,body,undefined,timeout);
      if(snapshot) {
        // A write reconciled while this GET was in flight is newer than the snapshot: keep the reconciled state.
        const fresh=await lock(async()=>{if(await generation()!==gen)return false;await save(result);return true});
        // The worker caches the canonical snapshot; pending local edits remain a separate overlay.
        const state=await projected();if(fresh)void warm(state);return state;
      }
      return result;
    }
    let registration;
    const started=(async()=>{
      if(!('serviceWorker'in navigator))throw Error('Offline storage is not supported in this browser');
      registration=await navigator.serviceWorker.register(absolute(c.worker||'sw.js'),{scope:base.pathname,updateViaCache:'none'});
      await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{
        const t=setTimeout(()=>reject(Error('Offline worker did not take control')),15000);
        navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(t);resolve()},{once:true});
      });
      try{await navigator.storage?.persist?.()}catch{}
      return registration;
    })();
    started.catch(e=>{warmingError='Offline saving unavailable: '+e.message;void notify()});
    async function warm(state) {
      if(warming||!state)return;warming=true;
      try {
        await started;
        const assets=[...new Set(c.assetURLs(state).map(absolute))].filter(u=>u.startsWith(base.origin+'/'));
        total=assets.length;done=0;ready=false;warmingError='';await notify();
        const dataCache=await caches.open(c.prefix+'data-v1');
        for(const path of c.data||[]){const u=absolute(path);if(navigator.onLine){const r=await fetch(u,{cache:'no-store'});if(!r.ok||r.redirected)throw Error('Library could not be saved');await dataCache.put(u,r)}
          else if(!await dataCache.match(u))throw Error('Library is not saved on this device yet')}
        const cache=await caches.open(c.prefix+'assets-v1');let cursor=0;
        await Promise.all(Array.from({length:Math.min(c.concurrency||4,assets.length||1)},async()=>{
          while(cursor<assets.length){const u=assets[cursor++];if(!await cache.match(u)){
            const r=await fetch(u,{cache:'no-store',signal:AbortSignal.timeout(30000)});
            if(!r.ok||r.redirected)throw Error('Some artwork is not saved yet');await cache.put(u,r);
          }done++;await notify()}
        }));
        ready=true;
      }catch(e){warmingError=navigator.onLine?'Offline saving paused — '+e.message:''}
      finally{warming=false;await notify()}
    }
    addEventListener('online',()=>{void flush().then(()=>meta()).then(warm)});
    addEventListener('offline',()=>{void notify()});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&navigator.onLine){void flush();void registration?.update().catch(()=>{})}});
    // Bounded low-frequency retries only while visible; never a reload.
    const timer=setInterval(()=>{if(!document.hidden&&navigator.onLine)void flush()},30000);
    void notify();void flush();
    function dispose(){clearInterval(timer);channel?.close()}
    // Wipe this app's replica on this device (sign-out, a different owner, handing the device over):
    // the outbox and snapshot database and every <prefix> cache. Pending edits are lost; check status() first.
    async function clear(){
      dispose();
      try{(await dbp).close()}catch{}
      await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(c.prefix+'offline-v1');r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);r.onblocked=()=>resolve()});
      for(const key of await caches.keys())if(key.startsWith(c.prefix))await caches.delete(key);
      ready=false;done=total=0;
    }
    return Object.freeze({request,flush,retry,discard,status,started,warm,projected,clear,dispose});
  }
  globalThis.WizOffline=Object.freeze({version:1,create,presentation});
})();
