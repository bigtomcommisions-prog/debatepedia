// Application state, storage, rendering, graph, community, and UI logic.
const STORAGE_KEY = 'debatepedia-vault-v2';
let vault = null;
let view = 'vault';          // vault | graph | community | approved
let activeNoteId = null;
let openFolders = new Set();
let submitMode = 'new';      // new | edit
let editTargetId = null;

/* ---------------- utils ---------------- */
function uid(prefix){ return prefix+'-'+Math.random().toString(36).slice(2,9); }
function escapeHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---------------- storage ---------------- */
async function loadVault(){
  try{
    const res = await window.storage.get(STORAGE_KEY, true);
    vault = JSON.parse(res.value);
  }catch(e){
    vault = seedVault();
    await saveVault();
  }
}
async function saveVault(){
  try{ await window.storage.set(STORAGE_KEY, JSON.stringify(vault), true); }
  catch(e){ console.error('save failed', e); }
}
function allApproved(){ return vault.notes.filter(n=>n.status==='approved'); }
function noteByTitle(title){ return allApproved().find(n=>n.title.toLowerCase()===title.trim().toLowerCase()); }
function noteById(id){ return vault.notes.find(n=>n.id===id); }
function childrenOf(id){ return vault.notes.filter(n=>n.status==='approved' && n.parentId===id); }

const KIND_RANK = {topic:0, view:1, summary:2, argument:3};
function sortChildren(kids){
  return kids.slice().sort((a,b)=>{
    const kr = KIND_RANK[a.kind]-KIND_RANK[b.kind];
    if(kr!==0) return kr;
    if(a.kind==='argument'){
      const rr = (a.relation==='refutation'?1:0)-(b.relation==='refutation'?1:0);
      if(rr!==0) return rr;
    }
    return a.title.localeCompare(b.title);
  });
}
function ancestorPath(note){
  let chain=[]; let cur = note.parentId? noteById(note.parentId): null;
  while(cur){ chain.unshift(cur.title); cur = cur.parentId? noteById(cur.parentId): null; }
  return chain.join(' › ');
}
function fullPath(note){ const a = ancestorPath(note); return a? a+' › '+note.title : note.title; }
function expandToNote(note){
  let cur = note.parentId? noteById(note.parentId): null;
  while(cur){ openFolders.add(cur.id); cur = cur.parentId? noteById(cur.parentId): null; }
}
function chipHTML(kind, relation){
  if(kind==='topic') return `<span class="stance-chip chip-topic">Topic</span>`;
  if(kind==='view') return `<span class="stance-chip chip-view">View</span>`;
  if(kind==='summary') return `<span class="stance-chip chip-summary">Summary</span>`;
  if(kind==='argument') return `<span class="stance-chip ${relation==='refutation'?'con':'pro'}">${relation==='refutation'?'Refutation':'Supporting argument'}</span>`;
  return '';
}
function kindColor(n){
  if(n.kind==='topic') return '#d7b56d';
  if(n.kind==='view') return '#5fb0a5';
  if(n.kind==='summary') return '#b9b39a';
  return n.relation==='refutation' ? '#7a86f5' : '#e2703a';
}

/* ---------------- wikilink parsing ---------------- */
function parseWikilinksHTML(escapedText){
  return escapedText.replace(/\[\[([^\]]+)\]\]/g, (m, title)=>{
    const target = noteByTitle(title);
    if(target) return `<span class="wikilink" data-nav="${target.id}">${title}</span>`;
    return `<span class="wikilink missing">${title}</span>`;
  });
}
function renderContentHTML(text){
  const escaped = escapeHtml(text);
  return escaped.split(/\n\n+/).map(p=>`<p>${parseWikilinksHTML(p.replace(/\n/g,'<br>'))}</p>`).join('');
}
function findBacklinks(note){
  return allApproved().filter(n=> n.id!==note.id && new RegExp('\\[\\['+note.title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\]\\]','i').test(n.content));
}

/* ---------------- FOL validity checker ---------------- */
function normalize(s){
  return String(s||'').trim()
    .replace(/<->|<=>/g,'↔')
    .replace(/->|=>/g,'→')
    .replace(/!|~/g,'¬')
    .replace(/&&|&/g,'∧')
    .replace(/\|\|(?!\|)|\|/g,'∨')
    .replace(/\s+/g,' ')
    .trim();
}
function stripOuterParens(s){
  s = (s||'').trim();
  while(s.length>1 && s[0]==='(' && s[s.length-1]===')'){
    let depth=0, ok=true;
    for(let i=0;i<s.length;i++){
      if(s[i]==='(') depth++;
      else if(s[i]===')'){ depth--; if(depth===0 && i!==s.length-1){ ok=false; break; } }
    }
    if(ok) s = s.slice(1,-1).trim(); else break;
  }
  return s;
}
function topLevelSplit(raw, opChar){
  const s = stripOuterParens(normalize(raw));
  let depth=0;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(c==='(') depth++;
    else if(c===')') depth--;
    else if(depth===0 && c===opChar) return {left:s.slice(0,i).trim(), right:s.slice(i+1).trim()};
  }
  return null;
}
function atomEq(a,b){ return stripOuterParens(normalize(a)).toLowerCase()===stripOuterParens(normalize(b)).toLowerCase(); }
function negOf(raw){
  const s = stripOuterParens(normalize(raw));
  return s.startsWith('¬') ? s.slice(1).trim() : '¬'+s;
}
function checkValidity(premisesRaw, conclusionRaw){
  const premises = (premisesRaw||[]).map(p=>stripOuterParens(normalize(p))).filter(Boolean);
  const conclusion = stripOuterParens(normalize(conclusionRaw||''));
  if(!premises.length || !conclusion) return {status:'unrecognized', rule:null};

  for(const p of premises){
    const impl = topLevelSplit(p, '→');
    if(!impl) continue;
    for(const q of premises){
      if(q===p) continue;
      if(atomEq(q, impl.left) && atomEq(conclusion, impl.right)) return {status:'valid', rule:'Modus Ponens'};
      if(atomEq(q, impl.right) && atomEq(conclusion, impl.left)) return {status:'invalid', rule:'Affirming the Consequent'};
      if(atomEq(q, negOf(impl.right)) && atomEq(conclusion, negOf(impl.left))) return {status:'valid', rule:'Modus Tollens'};
      if(atomEq(q, negOf(impl.left)) && atomEq(conclusion, negOf(impl.right))) return {status:'invalid', rule:'Denying the Antecedent'};
    }
  }
  for(const p of premises){
    const i1 = topLevelSplit(p,'→'); if(!i1) continue;
    for(const q of premises){
      if(q===p) continue;
      const i2 = topLevelSplit(q,'→'); if(!i2) continue;
      if(atomEq(i1.right, i2.left) && atomEq(conclusion, i1.left+' → '+i2.right)) return {status:'valid', rule:'Hypothetical Syllogism'};
    }
  }
  for(const p of premises){
    const d = topLevelSplit(p,'∨'); if(!d) continue;
    for(const q of premises){
      if(q===p) continue;
      if(atomEq(q, negOf(d.left)) && atomEq(conclusion, d.right)) return {status:'valid', rule:'Disjunctive Syllogism'};
      if(atomEq(q, negOf(d.right)) && atomEq(conclusion, d.left)) return {status:'valid', rule:'Disjunctive Syllogism'};
    }
  }
  for(const p of premises){
    const c = topLevelSplit(p, '∧'); if(!c) continue;
    if(atomEq(conclusion, c.left) || atomEq(conclusion, c.right)) return {status:'valid', rule:'Conjunction Elimination'};
  }
  for(let i=0;i<premises.length;i++) for(let j=0;j<premises.length;j++){
    if(i===j) continue;
    if(atomEq(conclusion, premises[i]+' ∧ '+premises[j])) return {status:'valid', rule:'Conjunction Introduction'};
  }
  for(const p of premises){
    const m = p.match(/^∀\s*([A-Za-z])\s*(.+)$/);
    if(m){
      const v = m[1];
      const body = stripOuterParens(m[2].trim());
      const escapedBody = body.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const varRegex = new RegExp('\\b'+v+'\\b','g');
      const patternStr = '^'+escapedBody.replace(varRegex, '([A-Za-z0-9_]+)')+'$';
      try{
        const re = new RegExp(patternStr,'i');
        if(re.test(conclusion)) return {status:'valid', rule:'Universal Instantiation'};
      }catch(e){}
    }
  }
  return {status:'unrecognized', rule:null};
}
function renderFOL(note){
  if(note.kind!=='argument' || !(note.premises && note.premises.length && note.conclusion)) return '';
  const result = checkValidity(note.premises, note.conclusion);
  let badge;
  if(result.status==='valid') badge = `<span class="fol-badge fol-valid">✓ Valid — ${result.rule}</span>`;
  else if(result.status==='invalid') badge = `<span class="fol-badge fol-invalid">✗ Invalid — ${result.rule}</span>`;
  else if(note.manualValid===true) badge = `<span class="fol-badge fol-valid-manual">✓ Marked valid (manual)</span>`;
  else if(note.manualValid===false) badge = `<span class="fol-badge fol-invalid-manual">✗ Marked invalid (manual)</span>`;
  else badge = `<span class="fol-badge fol-unknown">— Not automatically determined</span>`;
  return `<div class="fol-box">
    <h5>Formal argument (FOL)</h5>
    <div class="fol-premises">${note.premises.map(p=>`<div class="fol-line">${escapeHtml(p)}</div>`).join('')}</div>
    <div class="fol-conclusion">∴ ${escapeHtml(note.conclusion)}</div>
    <div class="fol-result">${badge}${note.manualNote? `<div class="fol-note">${escapeHtml(note.manualNote)}</div>`:''}</div>
    <div class="fol-hint">Checked against classical inference rules — modus ponens/tollens, syllogisms, conjunction rules, universal instantiation — as a lightweight heuristic, not a full theorem prover.</div>
  </div>`;
}

/* ---------------- tabs ---------------- */
function renderTabs(){
  const counts = {
    vault: allApproved().length,
    graph: allApproved().length,
    community: vault.submissions.filter(s=>s.status==='pending').length,
    approved: allApproved().length
  };
  const labels = {vault:'Vault', graph:'Graph View', community:'Community', approved:'Approved'};
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = Object.keys(labels).map(k=>
    `<div class="tab ${view===k?'active':''}" data-tab="${k}">${labels[k]}${k!=='vault'? `<span class="count">${counts[k]}</span>`:''}</div>`
  ).join('');
  tabs.querySelectorAll('.tab').forEach(el=>{
    el.addEventListener('click', ()=>{ view = el.dataset.tab; render(); });
  });
}

/* ---------------- sidebar (tree by parentId) ---------------- */
function renderNode(note){
  const kids = sortChildren(childrenOf(note.id));
  const hasKids = kids.length>0;
  const isOpen = openFolders.has(note.id);
  const icon = note.kind==='topic'?'📁':note.kind==='view'?'◔':note.kind==='summary'?'▤':'';
  const dot = note.kind==='argument' ? `<span class="dot ${note.relation==='refutation'?'con':'pro'}"></span>` : '';
  const row = `<div class="tree-row ${isOpen?'open':''} ${activeNoteId===note.id?'active':''}" data-note="${note.id}">
      <span class="chev" data-toggle="${note.id}" style="visibility:${hasKids?'visible':'hidden'}">▶</span>
      ${icon? `<span>${icon}</span>` : dot}
      <span>${escapeHtml(note.title)}</span>
    </div>`;
  const childrenHtml = hasKids
    ? `<div class="tree-children" style="display:${isOpen?'block':'none'}">${kids.map(k=>renderNode(k)).join('')}</div>`
    : '';
  return `<div>${row}${childrenHtml}</div>`;
}
function renderSidebar(){
  const sb = document.getElementById('sidebar');
  const roots = sortChildren(vault.notes.filter(n=>n.status==='approved' && !n.parentId));
  sb.innerHTML = `<h4>Vault · ${allApproved().length} notes</h4>` + roots.map(r=>renderNode(r)).join('');
  sb.querySelectorAll('.chev').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      const id = el.dataset.toggle;
      if(openFolders.has(id)) openFolders.delete(id); else openFolders.add(id);
      renderSidebar();
    });
  });
  sb.querySelectorAll('.tree-row').forEach(el=>{
    el.addEventListener('click', ()=>{ activeNoteId = el.dataset.note; view='vault'; render(); });
  });
}

/* ---------------- reader view ---------------- */
function renderReader(){
  const main = document.getElementById('main');
  if(!activeNoteId){
    const first = allApproved().find(n=>!n.parentId) || allApproved()[0];
    if(first){ activeNoteId = first.id; expandToNote(first); renderSidebar(); }
  }
  const note = noteById(activeNoteId);
  if(!note){
    main.innerHTML = `<div class="empty-state"><div class="mark-big">◈</div><h2>Nothing here yet</h2><p>Pick a note from the vault, or submit the first one from the Community tab.</p></div>`;
    return;
  }
  const backlinks = findBacklinks(note);
  const crumb = ancestorPath(note);
  main.innerHTML = `<div class="reader">
    <div class="reader-actions"><button class="btn-edit" id="suggestEditBtn">Suggest an edit</button></div>
    <div class="eyebrow">${crumb? escapeHtml(crumb): 'Root'} ${chipHTML(note.kind, note.relation)}</div>
    <h1>${escapeHtml(note.title)}</h1>
    <div class="meta">by ${escapeHtml(note.author)} · ${new Date(note.createdAt).toLocaleDateString()}${note.editedAt? ` · edited ${new Date(note.editedAt).toLocaleDateString()}`:''}</div>
    <div class="content">${renderContentHTML(note.content)}</div>
    ${renderFOL(note)}
    <div class="tagrow">${(note.tags||[]).map(t=>`<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>
    <div class="backlinks">
      <h5>Linked from (${backlinks.length})</h5>
      ${backlinks.length? backlinks.map(b=>`<div class="backlink-item" data-nav="${b.id}">${escapeHtml(b.title)}</div>`).join('') : '<div style="color:var(--text-faint);font-size:13px;">No notes link here yet.</div>'}
    </div>
  </div>`;
  main.querySelectorAll('[data-nav]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const target = noteById(el.dataset.nav);
      if(target){ activeNoteId = target.id; expandToNote(target); renderSidebar(); renderReader(); }
    });
  });
  document.getElementById('suggestEditBtn').addEventListener('click', ()=>{
    submitMode='edit'; editTargetId=note.id; view='community'; render();
  });
}

/* ---------------- graph view ---------------- */
let graphState = null;
function buildGraphData(){
  const notes = allApproved();
  const nodes = notes.map(n=>({id:n.id, title:n.title, kind:n.kind, relation:n.relation, x: Math.random()*600-300, y: Math.random()*400-200, vx:0, vy:0}));
  const idSet = new Set(nodes.map(n=>n.id));
  const edges = [];
  notes.forEach(n=>{
    if(n.parentId && idSet.has(n.parentId)) edges.push({a:n.id, b:n.parentId, type:'hierarchy'});
    const matches = [...n.content.matchAll(/\[\[([^\]]+)\]\]/g)];
    matches.forEach(m=>{
      const target = noteByTitle(m[1]);
      if(target && target.id!==n.id && idSet.has(target.id)){
        if(!edges.find(e=> e.type==='link' && ((e.a===n.id&&e.b===target.id) || (e.a===target.id&&e.b===n.id))))
          edges.push({a:n.id, b:target.id, type:'link'});
      }
    });
  });
  return {nodes, edges};
}
function renderGraph(){
  const main = document.getElementById('main');
  main.innerHTML = `<div class="graph-wrap">
    <canvas id="graphCanvas"></canvas>
    <div class="graph-legend">
      <div class="li"><span class="dot neutral"></span>Topic</div>
      <div class="li"><span class="dot view"></span>View</div>
      <div class="li"><span class="dot summary"></span>Summary</div>
      <div class="li"><span class="dot pro"></span>Supporting</div>
      <div class="li"><span class="dot con"></span>Refutation</div>
    </div>
    <div class="graph-hint">drag nodes · click to open</div>
    <div class="graph-tooltip" id="gTooltip"></div>
  </div>`;
  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d');
  const wrap = canvas.parentElement;
  function resize(){ canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight; }
  resize();
  window.addEventListener('resize', resize);

  const data = buildGraphData();
  graphState = data;
  let dragging = null, panX=0, panY=0, isPanning=false, panStart=null;

  function tick(){
    const {nodes, edges} = data;
    for(let i=0;i<nodes.length;i++){
      for(let j=i+1;j<nodes.length;j++){
        const a=nodes[i], b=nodes[j];
        let dx=a.x-b.x, dy=a.y-b.y;
        let dist = Math.sqrt(dx*dx+dy*dy)||0.01;
        const force = 2200/(dist*dist);
        dx/=dist; dy/=dist;
        a.vx += dx*force; a.vy += dy*force;
        b.vx -= dx*force; b.vy -= dy*force;
      }
    }
    edges.forEach(e=>{
      const a = nodes.find(n=>n.id===e.a), b = nodes.find(n=>n.id===e.b);
      if(!a||!b) return;
      let dx=b.x-a.x, dy=b.y-a.y;
      let dist = Math.sqrt(dx*dx+dy*dy)||0.01;
      const rest = e.type==='hierarchy'? 110 : 150;
      const force = (dist-rest)*0.02;
      dx/=dist; dy/=dist;
      a.vx += dx*force; a.vy += dy*force;
      b.vx -= dx*force; b.vy -= dy*force;
    });
    nodes.forEach(n=>{
      if(n===dragging) return;
      n.vx += -n.x*0.002; n.vy += -n.y*0.002;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
    });
  }
  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.save();
    ctx.translate(canvas.width/2+panX, canvas.height/2+panY);
    data.edges.forEach(e=>{
      const a = data.nodes.find(n=>n.id===e.a), b = data.nodes.find(n=>n.id===e.b);
      if(!a||!b) return;
      if(e.type==='hierarchy'){
        ctx.strokeStyle = 'rgba(120,124,140,0.22)';
        ctx.setLineDash([3,4]);
      } else {
        ctx.strokeStyle = 'rgba(215,181,109,0.35)';
        ctx.setLineDash([]);
      }
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    });
    ctx.setLineDash([]);
    data.nodes.forEach(n=>{
      const r = n.kind==='topic'? 9 : n.kind==='view'? 7.5 : n.kind==='summary'? 6.5 : 6;
      ctx.beginPath();
      ctx.fillStyle = kindColor(n);
      ctx.shadowColor = kindColor(n);
      ctx.shadowBlur = n.id===activeNoteId? 16:6;
      ctx.arc(n.x,n.y,r,0,Math.PI*2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#e9e7e0';
      ctx.font = (n.kind==='topic'? '600 12px Fraunces':'500 11px Inter');
      ctx.textAlign = 'center';
      ctx.fillText(n.title.length>26? n.title.slice(0,24)+'…':n.title, n.x, n.y + r + 14);
    });
    ctx.restore();
  }
  function loop(){ tick(); draw(); graphState.raf = requestAnimationFrame(loop); }
  loop();

  function toWorld(mx,my){ return {x: mx - canvas.width/2 - panX, y: my - canvas.height/2 - panY}; }
  function nodeAt(mx,my){ const w = toWorld(mx,my); return data.nodes.find(n=> Math.hypot(n.x-w.x, n.y-w.y) < 14); }
  const tooltip = document.getElementById('gTooltip');
  canvas.addEventListener('mousedown', e=>{
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX-rect.left, e.clientY-rect.top);
    if(n){ dragging = n; } else { isPanning = true; panStart = {x:e.clientX-panX, y:e.clientY-panY}; }
  });
  window.addEventListener('mousemove', e=>{
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX-rect.left, my = e.clientY-rect.top;
    if(dragging){
      const w = toWorld(mx,my);
      dragging.x = w.x; dragging.y = w.y; dragging.vx=0; dragging.vy=0;
    } else if(isPanning){
      panX = e.clientX-panStart.x; panY = e.clientY-panStart.y;
    } else {
      const n = nodeAt(mx,my);
      if(n){
        tooltip.style.display='block';
        tooltip.style.left = (mx+16)+'px'; tooltip.style.top=(my+10)+'px';
        const full = noteById(n.id);
        tooltip.innerHTML = `<b>${escapeHtml(full.title)}</b>${escapeHtml(ancestorPath(full)||'Root')}`;
        canvas.style.cursor='pointer';
      } else { tooltip.style.display='none'; canvas.style.cursor='grab'; }
    }
  });
  window.addEventListener('mouseup', ()=>{ dragging=null; isPanning=false; });
  canvas.addEventListener('click', e=>{
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX-rect.left, e.clientY-rect.top);
    if(n){ activeNoteId = n.id; view='vault'; const full=noteById(n.id); expandToNote(full); render(); }
  });
}

/* ---------------- approved grid ---------------- */
function renderApprovedGrid(){
  const main = document.getElementById('main');
  const notes = allApproved().sort((a,b)=>b.createdAt-a.createdAt);
  main.innerHTML = `<div class="grid-view">
    <div class="grid-header"><h1>Approved library</h1></div>
    <p>Every note here has passed community review and is part of the permanent vault.</p>
    <div class="card-grid">
      ${notes.map(n=>`<div class="card" data-nav="${n.id}">
        ${chipHTML(n.kind, n.relation)}
        <h3>${escapeHtml(n.title)}</h3>
        <p>${escapeHtml(n.content.replace(/\[\[|\]\]/g,'').slice(0,110))}…</p>
        <div class="cardmeta"><span>${escapeHtml(ancestorPath(n)||'Root')}</span><span>${escapeHtml(n.author)}</span></div>
      </div>`).join('')}
    </div>
  </div>`;
  main.querySelectorAll('[data-nav]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const target = noteById(el.dataset.nav);
      activeNoteId = target.id; expandToNote(target); view='vault'; render();
    });
  });
}

/* ---------------- community ---------------- */
function noteOptions(selectedId){
  return allApproved().slice()
    .sort((a,b)=> fullPath(a).localeCompare(fullPath(b)))
    .map(n=>`<option value="${n.id}" ${selectedId===n.id?'selected':''}>${escapeHtml(fullPath(n))}</option>`).join('');
}
function renderCommunity(){
  const main = document.getElementById('main');
  const pending = vault.submissions.filter(s=>s.status==='pending').sort((a,b)=>b.createdAt-a.createdAt);
  const mode = submitMode;
  const editTarget = editTargetId ? noteById(editTargetId) : null;

  main.innerHTML = `<div class="grid-view">
    <div class="grid-header"><h1>Community</h1></div>
    <p>Add a new note to the vault, or suggest an edit to an existing one. Everything lands in the review queue below before it becomes part of the vault — anyone here can approve or decline, since this is a shared, open space.</p>
    <div class="submit-box">
      <div class="mode-toggle">
        <button class="mode-btn ${mode==='new'?'active':''}" id="mode-new">New note</button>
        <button class="mode-btn ${mode==='edit'?'active':''}" id="mode-edit">Suggest an edit</button>
      </div>
      ${mode==='new' ? `
        <div class="form-row">
          <input id="f-title" placeholder="Title">
          <select id="f-kind">
            <option value="topic">Topic</option>
            <option value="view">View</option>
            <option value="summary">Summary</option>
            <option value="argument">Argument</option>
          </select>
        </div>
        <div class="form-row">
          <select id="f-parent" style="flex:2">
            <option value="">— none (root topic) —</option>
            ${noteOptions(null)}
          </select>
          <select id="f-relation">
            <option value="supporting">Supports parent</option>
            <option value="refutation">Refutes / challenges parent</option>
          </select>
        </div>
        <div class="form-row full"><input id="f-tags" placeholder="Tags, comma separated"></div>
        <div class="form-row full">
          <textarea id="f-content" placeholder="Write the note. Link related notes with double brackets, e.g. [[Universal Basic Income]]"></textarea>
        </div>
        <div id="folSection"></div>
      ` : `
        <div class="form-row full"><select id="f-edit-target">${noteOptions(editTarget?editTarget.id:null)}</select></div>
        ${editTarget ? `
          <div class="form-row full"><input id="f-title" value="${escapeHtml(editTarget.title)}"></div>
          <div class="form-row full"><input id="f-tags" value="${escapeHtml((editTarget.tags||[]).join(', '))}"></div>
          <div class="form-row full"><textarea id="f-content">${escapeHtml(editTarget.content)}</textarea></div>
          <div id="folSection"></div>
        ` : `<div class="hint">Choose a note above to load it for editing.</div>`}
      `}
      <button class="btn btn-primary" id="f-submit" style="margin-top:6px;">${mode==='new'?'Submit for review':'Submit edit for review'}</button>
    </div>
    <div class="section-label">Pending review (${pending.length})</div>
    <div id="pendingList"></div>
  </div>`;

  function paintFOL(premisesVal, conclusionVal, manualVal, noteVal){
    const el = document.getElementById('folSection');
    if(!el) return;
    el.innerHTML = `
      <div class="form-row full">
        <textarea id="f-premises" placeholder="Premises, one per line, e.g. Consumer(x) → Pays(x, VAT)">${escapeHtml(premisesVal||'')}</textarea>
        <div class="hint">Optional formal premises for FOL validity checking. Use → ∧ ∨ ¬ ∀, or ASCII -&gt; &amp; | ! forall x.</div>
      </div>
      <div class="form-row">
        <input id="f-conclusion" placeholder="Conclusion" value="${escapeHtml(conclusionVal||'')}" style="flex:2">
        <select id="f-manual">
          <option value="auto" ${manualVal==null?'selected':''}>Let checker decide</option>
          <option value="valid" ${manualVal===true?'selected':''}>Assert valid</option>
          <option value="invalid" ${manualVal===false?'selected':''}>Assert invalid</option>
        </select>
      </div>
      <div class="form-row full"><input id="f-manual-note" placeholder="Rationale, if asserting manually (optional)" value="${escapeHtml(noteVal||'')}"></div>`;
  }

  if(mode==='new'){
    const kindSel = document.getElementById('f-kind');
    const relSel = document.getElementById('f-relation');
    function syncKind(){
      const isArg = kindSel.value==='argument';
      relSel.style.display = isArg? 'block':'none';
      if(isArg) paintFOL(); else document.getElementById('folSection').innerHTML='';
    }
    kindSel.addEventListener('change', syncKind);
    syncKind();
  } else if(editTarget && editTarget.kind==='argument'){
    paintFOL(
      (editTarget.premises||[]).join('\n'),
      editTarget.conclusion||'',
      editTarget.manualValid===undefined? null : editTarget.manualValid,
      editTarget.manualNote||''
    );
  }

  document.getElementById('mode-new').addEventListener('click', ()=>{ submitMode='new'; render(); });
  document.getElementById('mode-edit').addEventListener('click', ()=>{ submitMode='edit'; if(!editTargetId) editTargetId = allApproved()[0]?.id||null; render(); });
  if(mode==='edit'){
    const sel = document.getElementById('f-edit-target');
    if(sel) sel.addEventListener('change', ()=>{ editTargetId = sel.value; render(); });
  }

  renderPendingList(pending);

  document.getElementById('f-submit').addEventListener('click', async ()=>{
    if(mode==='new') await submitNew(); else await submitEdit();
  });
}
async function submitNew(){
  const title = document.getElementById('f-title').value.trim();
  const content = document.getElementById('f-content').value.trim();
  const kind = document.getElementById('f-kind').value;
  const parentId = document.getElementById('f-parent').value || null;
  const relEl = document.getElementById('f-relation');
  const tags = document.getElementById('f-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
  if(!title || !content){ alert('Give the note a title and some content first.'); return; }
  const sub = { id: uid('s'), type:'new', kind, parentId,
    relation: kind==='argument' && relEl ? relEl.value : null,
    title, content, tags, author:'you', createdAt: Date.now(), status:'pending' };
  if(kind==='argument'){
    const premEl = document.getElementById('f-premises');
    if(premEl && premEl.value.trim()){
      sub.premises = premEl.value.split('\n').map(p=>p.trim()).filter(Boolean);
      sub.conclusion = document.getElementById('f-conclusion').value.trim();
      const manEl = document.getElementById('f-manual');
      sub.manualValid = manEl.value==='valid'? true : manEl.value==='invalid'? false : null;
      sub.manualNote = document.getElementById('f-manual-note').value.trim();
    }
  }
  vault.submissions.push(sub);
  await saveVault();
  render();
}
async function submitEdit(){
  if(!editTargetId) return;
  const target = noteById(editTargetId);
  const title = document.getElementById('f-title').value.trim();
  const content = document.getElementById('f-content').value.trim();
  const tags = document.getElementById('f-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
  if(!title || !content){ alert('Title and content are required.'); return; }
  const sub = { id: uid('e'), type:'edit', targetId: editTargetId,
    proposedTitle:title, proposedContent:content, proposedTags:tags,
    author:'you', createdAt: Date.now(), status:'pending' };
  if(target.kind==='argument'){
    const premEl = document.getElementById('f-premises');
    if(premEl){
      sub.proposedPremises = premEl.value.split('\n').map(p=>p.trim()).filter(Boolean);
      sub.proposedConclusion = document.getElementById('f-conclusion').value.trim();
      const manEl = document.getElementById('f-manual');
      sub.proposedManualValid = manEl.value==='valid'? true : manEl.value==='invalid'? false : null;
      sub.proposedManualNote = document.getElementById('f-manual-note').value.trim();
    }
  }
  vault.submissions.push(sub);
  await saveVault();
  editTargetId = null;
  render();
}
function renderPendingList(pending){
  const list = document.getElementById('pendingList');
  if(pending.length===0){
    list.innerHTML = `<div style="color:var(--text-faint);font-size:13px;">Nothing waiting right now.</div>`;
    return;
  }
  list.innerHTML = pending.map(s=>{
    if(s.type==='edit'){
      const target = noteById(s.targetId);
      return `<div class="pending-card">
        <div class="top">
          <div>
            <span class="badge-pending" style="background:var(--view-dim);color:var(--view);">Proposed edit</span>
            <h4>${escapeHtml(target? target.title : 'Unknown note')}</h4>
            <div style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-faint);">by ${escapeHtml(s.author)}</div>
          </div>
          <span class="badge-pending">Pending</span>
        </div>
        <div class="diff-block diff-current"><span class="diff-label">Current</span>${escapeHtml((target?target.content:'').slice(0,180))}${target && target.content.length>180?'…':''}</div>
        <div class="diff-block diff-proposed"><span class="diff-label">Proposed</span>${escapeHtml(s.proposedContent.slice(0,180))}${s.proposedContent.length>180?'…':''}</div>
        <div class="pending-actions">
          <button class="btn btn-approve" data-approve="${s.id}">Approve edit</button>
          <button class="btn btn-reject" data-reject="${s.id}">Decline</button>
        </div>
      </div>`;
    }
    const parentText = s.parentId && noteById(s.parentId) ? fullPath(noteById(s.parentId)) : 'Root topic';
    return `<div class="pending-card">
      <div class="top">
        <div>
          ${chipHTML(s.kind, s.relation)}
          <h4>${escapeHtml(s.title)}</h4>
          <div style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-faint);">${escapeHtml(parentText)} · by ${escapeHtml(s.author)}</div>
        </div>
        <span class="badge-pending">Pending</span>
      </div>
      <p>${escapeHtml(s.content.slice(0,220))}${s.content.length>220?'…':''}</p>
      ${s.premises && s.premises.length ? `<div class="hint">FOL: ${s.premises.length} premise(s) → ${escapeHtml(s.conclusion||'')}</div>` : ''}
      <div class="pending-actions">
        <button class="btn btn-approve" data-approve="${s.id}">Approve</button>
        <button class="btn btn-reject" data-reject="${s.id}">Decline</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-approve]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      const sub = vault.submissions.find(s=>s.id===el.dataset.approve);
      if(sub.type==='edit'){
        const target = noteById(sub.targetId);
        if(target){
          target.title = sub.proposedTitle;
          target.content = sub.proposedContent;
          target.tags = sub.proposedTags;
          if(target.kind==='argument' && sub.proposedPremises){
            target.premises = sub.proposedPremises;
            target.conclusion = sub.proposedConclusion;
            target.manualValid = sub.proposedManualValid;
            target.manualNote = sub.proposedManualNote;
          }
          target.editedAt = Date.now();
        }
      } else {
        sub.status='approved';
        vault.notes.push(sub);
      }
      vault.submissions = vault.submissions.filter(x=>x.id!==sub.id);
      await saveVault();
      render();
    });
  });
  list.querySelectorAll('[data-reject]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      vault.submissions = vault.submissions.filter(s=>s.id!==el.dataset.reject);
      await saveVault();
      render();
    });
  });
}

/* ---------------- root render ---------------- */
function stopGraphLoop(){ if(graphState && graphState.raf){ cancelAnimationFrame(graphState.raf); graphState=null; } }
function render(){
  stopGraphLoop();
  renderTabs();
  renderSidebar();
  if(view==='vault') renderReader();
  else if(view==='graph') renderGraph();
  else if(view==='community') renderCommunity();
  else if(view==='approved') renderApprovedGrid();
}

(async function init(){
  document.getElementById('main').innerHTML = '<div class="loading">Opening vault…</div>';
  await loadVault();
  render();
})();
