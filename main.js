// Athens Hex-Minesweeper — vanilla JS (clean, auto-neighbors + close X)
const DATA_URL = 'data/athens_hex_counts.geojson';

let geojson = null, cells = [];
let revealedCount = 0, totalSafe = 0, threshold = 15;
let neighborGraphReady = false, histChart = null;
let gameOver = false; // ✅ νέα σημαία: όταν χάνεις κλειδώνει το board

// (flat-top hex): H = width, V = height
const PRESET_GRID = { H: 316, V: 274 }; // 

// DOM
const boardSVG      = document.getElementById('board');
const dataStatus    = document.getElementById('dataStatus');
const thresholdInput= document.getElementById('threshold');
const thresholdVal  = document.getElementById('thresholdVal');
const btnReset      = document.getElementById('btnReset');

// Overlay 
const overlay       = document.getElementById('overlay');
const overlayTitle  = document.getElementById('overlayTitle');
const overlayMsg    = document.getElementById('overlayMsg');
const overlayClose  = document.getElementById('overlayClose');

const MINE_ICON_URL = 'img/explosion.png';

// Helpers
const toRad = d => d * Math.PI / 180;
function haversine(lat1, lon1, lat2, lon2){
  const R=6371000, dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function bboxOfFeature(f){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const ring = f.geometry.type==='Polygon'? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
  for(const [x,y] of ring){ if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
  return {minX,minY,maxX,maxY};
}
function centroidOfFeature(f){
  const ring = f.geometry.type==='Polygon'? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
  let A=0,cx=0,cy=0;
  for(let i=0;i<ring.length-1;i++){
    const [x1,y1]=ring[i],[x2,y2]=ring[i+1];
    const cr = x1*y2 - x2*y1; A+=cr; cx+=(x1+x2)*cr; cy+=(y1+y2)*cr;
  }
  A *= 0.5;
  if (Math.abs(A) < 1e-12){
    const s=ring.reduce((a,[x,y])=>[a[0]+x,a[1]+y],[0,0]);
    return {cx:s[0]/ring.length, cy:s[1]/ring.length};
  }
  return {cx:cx/(6*A), cy:cy/(6*A)};
}
function transformToViewBox(features){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const f of features){
    const b=bboxOfFeature(f);
    if(b.minX<minX)minX=b.minX; if(b.maxX>maxX)maxX=b.maxX;
    if(b.minY<minY)minY=b.minY; if(b.maxY>maxY)maxY=b.maxY;
  }
  const padX=(maxX-minX)*0.04, padY=(maxY-minY)*0.04;
  minX-=padX; maxX+=padX; minY-=padY; maxY+=padY;
  const width=1000, height=1000*(maxY-minY)/(maxX-minX);
  boardSVG.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const sx=width/(maxX-minX), sy=height/(maxY-minY);
  return (x,y)=>({x:(x-minX)*sx, y:(maxY-y)*sy});
}
function featureToPath(f, conv){
  const ring = f.geometry.type==='Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
  let d=''; ring.forEach(([x,y],i)=>{ const p=conv(x,y); d+=(i?'L':'M')+p.x+' '+p.y+' '; }); return d+'Z';
}

// Load data
async function loadData(){
  const res = await fetch(DATA_URL,{cache:'no-store'});
  if(!res.ok) throw new Error('Failed to load '+DATA_URL);
  const gj = await res.json();
  geojson = gj;
  const features = gj.features;
  if(!features?.length) throw new Error('GeoJSON has no features');

  dataStatus && (dataStatus.textContent = `Loaded ${features.length} cells.`);

  const conv = transformToViewBox(features);
  const countField = 'NUMPOINTS'; // 

  cells = features.map((f,idx)=>{
    const {cx,cy} = centroidOfFeature(f);
    const raw = f.properties[countField];
    let count = null;
    if (raw===null || raw===undefined || raw==='') count = null;
    else if (typeof raw==='number') count = Number.isFinite(raw) ? raw : null;
    else { const p=parseFloat(raw); count = Number.isFinite(p) ? p : null; }
    return {
      id: idx, feat:f, polySvgPath: featureToPath(f,conv), cx, cy,
      count, neighbors:[], state:'hidden', isMine:false, adjMines:0,
      isZero: (count===null), // 
      boom: false             // 
    };
  });

  drawBoard();
  buildHistogram(cells.map(c => (c.count ?? 0)));

  
  computeNeighborsFixed();
  assignMines();
  updateStyles();
  neighborGraphReady = true;

  dataStatus && (dataStatus.textContent = `Ready. Safe cells: ${totalSafe} (H=${PRESET_GRID.H}m, V=${PRESET_GRID.V}m)`);
}

// Neighbors (fixed H/V)
function computeNeighborsFixed(){
  const h = PRESET_GRID.H, v = PRESET_GRID.V;
  const dHoriz = 0.75*h, dDiag = v, tol = 0.20;
  const minH=dHoriz*(1-tol), maxH=dHoriz*(1+tol);
  const minD=dDiag *(1-tol), maxD=dDiag *(1+tol);

  const bucket=new Map(), cellSize=0.01, key=(lat,lon)=>`${Math.floor(lat/cellSize)}|${Math.floor(lon/cellSize)}`;
  cells.forEach(c=>{ const k=key(c.cy,c.cx); if(!bucket.has(k)) bucket.set(k,[]); bucket.get(k).push(c); });
  const candidates=(c)=>{ const i=Math.floor(c.cy/cellSize), j=Math.floor(c.cx/cellSize);
    const list=[]; for(let di=-1;di<=1;di++) for(let dj=-1;dj<=1;dj++){ const k=`${i+di}|${j+dj}`; if(bucket.has(k)) list.push(...bucket.get(k)); } return list; };

  cells.forEach(c=>c.neighbors=[]);
  for(const c of cells){
    for(const o of candidates(c)){
      if(o.id===c.id) continue;
      const dist = haversine(c.cy,c.cx,o.cy,o.cx);
      if((dist>=minH && dist<=maxH) || (dist>=minD && dist<=maxD)) c.neighbors.push(o.id);
    }
  }
}

// Mines / game state
function assignMines(){
  if (thresholdInput) threshold = parseInt(thresholdInput.value,10);
  if (thresholdVal)   thresholdVal.textContent = String(threshold);
  revealedCount = 0;
  cells.forEach(c=>{
    c.isMine = (c.count!==null && c.count >= threshold);
    c.adjMines = 0;
    c.state = 'hidden';
    c.boom = false; // 
  });
  for(const c of cells){
    let m=0; for(const nid of c.neighbors) if(cells[nid].isMine) m++; c.adjMines = m;
  }
  totalSafe = cells.filter(c => !c.isZero && !c.isMine).length;

  
  gameOver = false;
  boardSVG.classList.remove('locked');
}


function drawBoard(){
  boardSVG.innerHTML='';
  const g=document.createElementNS('http://www.w3.org/2000/svg','g');
  g.setAttribute('id','hexes'); boardSVG.appendChild(g);
  for(const c of cells){
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d', c.polySvgPath);
    path.classList.add('hex','hidden');
    path.dataset.id=c.id;
    if (c.isZero){
      path.classList.add('disabled-cell');
    } else {
      path.addEventListener('click', onLeft);
      path.addEventListener('contextmenu', (e)=>{ e.preventDefault(); onRight(e); });
    }
    g.appendChild(path);

    const text=document.createElementNS('http://www.w3.org/2000/svg','text');
    text.setAttribute('class','count-label');
    text.setAttribute('x','0'); text.setAttribute('y','0');
    text.dataset.id=c.id;
    g.appendChild(text);
  }
  Array.from(boardSVG.querySelectorAll('path.hex')).forEach(p=>{
    const bb = p.getBBox();
    const id = parseInt(p.dataset.id,10);
    const label = boardSVG.querySelector(`text.count-label[data-id="${id}"]`);
    label.setAttribute('x', (bb.x + bb.width/2).toFixed(1));
    label.setAttribute('y', (bb.y + bb.height/2).toFixed(1));
  });
}

function updateStyles(){
  
  boardSVG.querySelectorAll('image.mine-icon').forEach(el => el.remove());

  for(const c of cells){
    const path  = boardSVG.querySelector(`path.hex[data-id="${c.id}"]`);
    const label = boardSVG.querySelector(`text.count-label[data-id="${c.id}"]`);

    path.classList.remove('hidden','revealed','mine','safe','flagged','disabled-cell');

    if (c.isZero){
      path.classList.add('hex','hidden','disabled-cell');
      label.textContent = '';
      continue;
    }

    if(c.state==='hidden'){
      path.classList.add('hex','hidden');
      label.textContent = '';
    }
    else if(c.state==='flagged'){
      path.classList.add('hex','flagged');
      label.textContent = '⚑';
    }
    else if(c.state==='revealed'){
      if(c.isMine){
        
        path.classList.add('hex','revealed','mine');
        label.textContent = '';

        
        if (c.boom){
          const bb   = path.getBBox();
          const size = Math.min(bb.width, bb.height) * 0.65;
          const x    = bb.x + (bb.width  - size)/2;
          const y    = bb.y + (bb.height - size)/2;

          const img = document.createElementNS('http://www.w3.org/2000/svg','image');
          img.setAttribute('x',      x.toFixed(1));
          img.setAttribute('y',      y.toFixed(1));
          img.setAttribute('width',  size.toFixed(1));
          img.setAttribute('height', size.toFixed(1));
          img.setAttribute('class',  'mine-icon');
          img.dataset.id = c.id;

          
          img.setAttribute('href', MINE_ICON_URL);
          img.setAttributeNS('http://www.w3.org/1999/xlink','href', MINE_ICON_URL);

          boardSVG.querySelector('#hexes').appendChild(img);
        }
      } else {
        path.classList.add('hex','revealed','safe');
        label.textContent = c.adjMines>0 ? String(c.adjMines) : '';
      }
    }
  }
}


function floodReveal(id){
  const q=[id], seen=new Set();
  while(q.length){
    const cur=q.shift(); if(seen.has(cur)) continue; seen.add(cur);
    const c=cells[cur]; if(c.state==='revealed') continue;
    c.state='revealed'; if(!c.isMine) revealedCount++;
    if(c.adjMines===0 && !c.isMine){
      for(const nid of c.neighbors){
        const n=cells[nid];
        if(n.state!=='revealed' && !n.isMine && !n.isZero) q.push(nid);
      }
    }
  }
}
function onLeft(e){
  if (gameOver) return; // 

  const id=parseInt(e.currentTarget.dataset.id,10);
  const c=cells[id];
  if(c.isZero || c.state==='flagged' || c.state==='revealed') return;

  if (c.isMine){
  c.boom = true;        // 
  revealAllMines();     // 
  revealAllSafe();      // 
  revealedCount = totalSafe;
  gameOver = true;
  boardSVG.classList.add('locked');
  updateStyles();       // 
  showOverlay('Game Over','You clicked on a mine.');
  return;
}


  if(c.adjMines===0) floodReveal(id);
  else { c.state='revealed'; revealedCount++; }
  updateStyles(); checkWin();
}


function onRight(e){
  if (gameOver) return; // 

  const id=parseInt(e.currentTarget.dataset.id,10);
  const c=cells[id];
  if(c.isZero || c.state==='revealed') return;
  c.state = (c.state==='flagged')? 'hidden':'flagged';
  updateStyles();
}

function revealAllMines(){ for(const c of cells){ if(c.isMine) c.state='revealed'; } updateStyles(); }
function revealAllSafe(){
  for (const c of cells){
    if (!c.isZero && !c.isMine){
      c.state = 'revealed';   // 
    }
  }
  updateStyles();
}
function checkWin(){ if(totalSafe>0 && revealedCount>=totalSafe) showOverlay('Nice!','You revealed all safe cells.'); }
function showOverlay(t,m){ overlayTitle.textContent=t; overlayMsg.textContent=m; overlay.classList.remove('hidden'); }
function hideOverlay(){ overlay.classList.add('hidden'); }

// Histogram
function buildHistogram(values){
  if(!('Chart' in window)) return;
  const maxVal = Math.max(...values);
  const binSize = Math.max(5, Math.ceil(maxVal/20));
  const bins=[], labels=[];
  for(let s=0;s<=maxVal;s+=binSize){ bins.push(0); labels.push(`${s}–${s+binSize}`); }
  for(const v of values){ const i=Math.min(Math.floor(v/binSize), bins.length-1); bins[i]++; }
  const ctx=document.getElementById('hist')?.getContext('2d'); if(!ctx) return;
  if(histChart) histChart.destroy();
  histChart = new Chart(ctx,{ type:'bar', data:{ labels, datasets:[{ label:'Cells', data:bins }] },
    options:{ responsive:true, animation:false, plugins:{ legend:{display:false}, title:{display:false}},
      scales:{ x:{ticks:{autoSkip:true,maxRotation:0}}, y:{beginAtZero:true} } } });
}

// Overlay close handlers
overlayClose?.addEventListener('click', ()=> hideOverlay());
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !overlay.classList.contains('hidden')) hideOverlay(); });
overlay.addEventListener('click', (e)=>{ if(e.target===overlay) hideOverlay(); });

// Auto-load
window.addEventListener('DOMContentLoaded', async ()=>{
  // 
  if (thresholdInput) {
    threshold = 15;                 // 
    thresholdInput.value = '15';    // 
    if (thresholdVal) thresholdVal.textContent = '15'; // 
  }

  try{
    await loadData(); // 
  }catch(err){
    dataStatus && (dataStatus.textContent='Error: '+err.message);
    console.error(err);
  }
});


// Threshold / New game
thresholdInput?.addEventListener('input', ()=>{ thresholdVal.textContent = thresholdInput.value; });
thresholdInput?.addEventListener('change', ()=>{ assignMines(); updateStyles(); });
btnReset?.addEventListener('click', ()=>{ assignMines(); updateStyles(); hideOverlay(); });

