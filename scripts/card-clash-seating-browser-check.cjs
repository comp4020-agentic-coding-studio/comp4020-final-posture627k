// Real Chromium: four table edges, fixed clockwise identity, and physical targeting.
// node scripts/card-clash-seating-browser-check.cjs APP_URL EVIDENCE_DIR PLAYWRIGHT_MODULE
const {chromium}=require(process.argv[4]||process.env.PLAYWRIGHT_MODULE||'playwright');
const {fixture}=require('./card-clash-browser-check.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const base=process.argv[2]||process.env.APP_URL||'http://127.0.0.1:8787';
const out=path.resolve(process.argv[3]||'four-seat-evidence');
const sizes=process.env.VIEWPORTS?JSON.parse(process.env.VIEWPORTS):[[1920,1080],[1366,768],[844,390],[390,844]];
const positions=['left','across','right'];
const targetSeat=(viewer,offset)=>(viewer-1+offset)%4+1;
const overlaps=(a,b)=>a.x<b.right-1&&a.right>b.x+1&&a.y<b.bottom-1&&a.bottom>b.y+1;
async function exposed(card){return card.evaluate(e=>{const r=e.getBoundingClientRect();for(let y=r.top+6;y<r.bottom-5;y+=4)for(let x=r.left+6;x<r.right-5;x+=4){const hit=document.elementFromPoint(x,y);if(hit?.closest('.card')===e&&hit.closest('button'))return{x,y};}throw Error('No exposed card');});}
async function run(){
 await fs.mkdir(out,{recursive:true});const browser=await chromium.launch({headless:true,channel:'chrome'});
 const records=[],gestures=[],auxiliary=[],errors=[];
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));let f,posts=[];
  await page.route('**/api/card-clash/rooms/**',route=>{
   if(route.request().url().endsWith('/events'))return route.abort();
   if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
   return route.fulfill({json:route.request().url().endsWith('/state')?f.state:f.metadata});
  });
  async function open(viewer,n,phase){
   f=fixture('2v2',viewer,n,['complete','eliminated','target'].includes(phase)?'main':phase);posts=[];
   if(phase==='complete')f.state.matchResult={status:'complete',winningTeam:'A'};
   if(phase==='eliminated'){const p=f.state.players.find(p=>p.seat===targetSeat(viewer,1));p.eliminated=true;p.hp=0;}
   await page.goto(base+'/card-clash?room=P53AUDIT');await page.waitForSelector('#hand .card');await page.mouse.move(2,2);
   await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));});
   if(phase==='target'){await page.locator('#hand .card-attack button').focus();await page.keyboard.press('Enter');}
   await page.waitForTimeout(190);
  }
  async function geometry(){return page.evaluate(()=>{
   const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
   const reachable=e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));};
   return {stations:[...document.querySelectorAll('.around-table .knight-stand')].map(e=>({position:e.dataset.position,seat:Number(e.dataset.playerSeat),...rect(e.querySelector('.seat')),reachable:reachable(e.querySelector('.seat'))})),
    cards:[...document.querySelectorAll('#hand .card')].map(rect),guide:rect(document.querySelector('#decision-guide')||document.querySelector('.victory')),clock:rect(document.querySelector('.centerpiece')),
    extras:[...document.querySelectorAll('.pile-label,.chronicle')].map(e=>({name:e.className,...rect(e)})),
    controls:[...document.querySelectorAll('.zone button,.mini-controls button,.topbar a,.topbar button')].filter(e=>e.checkVisibility()&&!e.disabled).map(e=>({id:e.id,reachable:reachable(e),...rect(e)})),
    scrollWidth:document.documentElement.scrollWidth};
  });}
  let current='';
  try{
   for(const [width,height] of sizes){await page.setViewportSize({width,height});
    for(const viewer of [1,2,3,4]){
     for(const [n,phase] of [[4,'main'],[5,'main'],[6,'main'],[6,'target'],[6,'attack'],[6,'war_cry'],[6,'rescue'],[6,'discard'],[6,'complete'],[6,'eliminated']]){
      current=`${width}-seat${viewer}-${phase}${n}`;await open(viewer,n,phase);const m=await geometry();
      assert.equal(m.stations.length,3);assert(m.scrollWidth<=width+1);
      const at={};for(const [i,pos] of positions.entries()){
       const r=m.stations.find(r=>r.position===pos);assert(r,`${current}: missing ${pos}`);at[pos]=r;
       assert.equal(r.seat,targetSeat(viewer,i+1));assert(r.reachable,`${current}: seat ${r.seat} obscured`);
       assert(r.x>=0&&r.y>=48&&r.right<=width&&r.bottom<=height,`${current}: station clipped ${JSON.stringify(r)}`);
       for(const c of m.cards)assert(!overlaps(r,c),`${current}: station covers fan`);
       for(const e of [m.guide,m.clock,...m.extras])assert(!overlaps(r,e),`${current}: station overlaps ${e.name||'guide/clock'} ${JSON.stringify({r,e})}`);
      }
      assert(at.left.x+at.left.width/2<width*.32&&at.right.x+at.right.width/2>width*.68,`${current}: seats must use side edges`);
      assert(Math.abs(at.across.x+at.across.width/2-width/2)<width*.06,`${current}: across not centered`);
      assert(at.across.y+at.across.height/2+20<Math.min(at.left.y+at.left.height/2,at.right.y+at.right.height/2),`${current}: other players still form a far row`);
      for(const c of m.cards)assert(!overlaps(m.guide,c),`${current}: prompt/result covered by fan`);
      assert(!overlaps(m.guide,m.clock),`${current}: clock and prompt overlap ${JSON.stringify(m)}`);
      for(const c of m.controls)assert(c.reachable&&c.x>=0&&c.y>=0&&c.right<=width&&c.bottom<=height,`${current}: control blocked ${JSON.stringify(c)}`);
      if(viewer===1&&(phase==='main'&&n===6||phase==='attack'||phase==='rescue'))await page.screenshot({path:path.join(out,current+'.png')});
      if(phase==='main'&&n===6&&viewer!==1)await page.screenshot({path:path.join(out,current+'.png')});
      records.push({viewport:[width,height],viewer,n,phase,...m});
     }
     for(const [i,pos] of positions.entries()){
      current=`${width}-seat${viewer}-drag-${pos}`;await open(viewer,6,'main');
      f.state.players.find(p=>p.seat===viewer).hand[0].type=['attack','seize','disarm'][i];f.state.version++;await page.evaluate(()=>window.__cardClash.refresh(true));
      const card=page.locator('#hand .card').first();let p=await exposed(card);await page.mouse.move(p.x,p.y);await page.waitForTimeout(190);p=await exposed(card);
      await page.mouse.move(p.x,p.y);await page.mouse.down();const station=page.locator('.position-'+pos+' .seat');const r=await station.boundingBox();
      await page.mouse.move(r.x+r.width/2,r.y+r.height/2,{steps:10});await page.waitForTimeout(30);
      assert.equal(await page.locator('.drag-ghost').count(),1);assert(await station.evaluate(e=>e.classList.contains('drop-ready')));
      await page.mouse.up();await page.waitForTimeout(70);assert.equal(posts.length,1);assert.equal(posts[0].targetSeat,targetSeat(viewer,i+1));
      gestures.push({viewport:[width,height],viewer,position:pos,type:posts[0].type,target:posts[0].targetSeat});
     }
    }
    // The full-stage seat container must leave direct table drops and the
    // keyboard/Cancel alternatives usable at every viewport.
    await open(1,6,'main');
    let card=page.locator('#hand .card').first(),p=await exposed(card);
    await page.mouse.move(p.x,p.y);await page.waitForTimeout(190);p=await exposed(card);
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    const left=await page.locator('.position-left .seat').boundingBox();
    await page.mouse.move(left.x+left.width/2,left.y+left.height/2,{steps:8});
    await page.keyboard.press('Escape');await page.mouse.up();await page.waitForTimeout(190);
    assert.equal(posts.length,0);assert.equal(await page.locator('.drag-ghost').count(),0);
    await page.locator('#hand .card-attack button').focus();await page.keyboard.press('Enter');
    await page.locator('#cancel-target').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#hand .card.targeting').count(),0);
    await page.locator('#hand .card-attack button').focus();await page.keyboard.press('Enter');
    assert.match(await page.locator('#target-4').getAttribute('aria-label'),/seat 4, Team A/);
    await page.locator('#target-4').focus();await page.keyboard.press('Enter');await page.waitForTimeout(70);
    assert.equal(posts.length,1);assert.equal(posts[0].targetSeat,4);
    auxiliary.push({viewport:[width,height],cancel:'Escape drag + keyboard Cancel passed',keyboard:'right seat target 4 passed'});
    await open(1,6,'main');f.state.players[0].hand[0].type='insight';f.state.version++;
    await page.evaluate(()=>window.__cardClash.refresh(true));card=page.locator('#hand .card').first();
    p=await exposed(card);await page.mouse.move(p.x,p.y);await page.waitForTimeout(190);p=await exposed(card);
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    const table=await page.evaluate(()=>{
     const r=document.querySelector('.table-drop-area').getBoundingClientRect();
     for(let y=Math.max(2,r.top+8);y<Math.min(innerHeight-2,r.bottom-8);y+=8)
      for(let x=Math.max(2,r.left+8);x<Math.min(innerWidth-2,r.right-8);x+=8){
       const hit=document.elementFromPoint(x,y);
       if(hit?.closest('.stage')&&!hit.closest('.far,.zone,.centerpiece,.chronicle,.pile,button,a'))return{x,y};
      }
     throw Error('No exposed central-table direct drop');
    });
    await page.mouse.move(table.x,table.y,{steps:8});await page.mouse.up();await page.waitForTimeout(70);
    assert.equal(posts.length,1);assert.equal(posts[0].type,'play_insight');
    auxiliary[auxiliary.length-1].directTable='Insight drop outside prompt passed';
    console.log(`Four-edge seats, phases, 4/5/6 cards and directional drags passed at ${width}x${height}`);
   }
  }catch(e){await page.screenshot({path:path.join(out,'failure-'+current+'.png')});throw e;}
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'bounds.json'),JSON.stringify(records,null,2));
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({browser:await browser.version(),viewports:sizes,projectionCases:records.length,directionalDrags:gestures,auxiliary,pageErrors:errors,fixtures:'deterministic filtered projections with real page/assets; human acceptance pending'},null,2));
 }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1});