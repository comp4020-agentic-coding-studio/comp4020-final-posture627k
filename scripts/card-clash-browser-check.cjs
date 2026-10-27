// Real Chromium layout and pointer regressions. Requires an externally available
// Playwright installation; no application dependency is added.
// APP_URL=http://127.0.0.1:8787 PLAYWRIGHT_MODULE=/path/to/playwright node scripts/card-clash-browser-check.cjs /path/to/evidence
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.APP_URL || 'http://127.0.0.1:8787';
const out = path.resolve(process.argv[2] || 'p53-browser-evidence');
const types = ['attack', 'dodge', 'heal', 'insight', 'seize', 'arrow_volley'];
const sizes = process.env.VIEWPORTS ? JSON.parse(process.env.VIEWPORTS) : [[1920,1080],[1366,768],[844,390],[390,844]];
function fixture(mode='1v1', seat=1, n=6, phase='main') {
  const count = {'1v1':2,'1v2':3,'2v2':4}[mode];
  const foe = seat===1 ? 2 : 1;
  const players = Array.from({length:count},(_,i)=>({seat:i+1,team:mode==='2v2' ? (i===0||i===3?'A':'B') : i===0?'A':'B',maxHp:mode==='1v2'&&i===0?5:3,hp:mode==='1v2'&&i===0?4:2,eliminated:false,handSize:i+1===seat?n:4,...(i+1===seat?{hand:Array.from({length:n},(_,j)=>({id:'qa'+j,type:types[j%types.length]}))}:{})}));
  const state = {matchId:1,roomId:1,version:2,mode,viewerSeat:seat,activeSeat:seat,normalAttacksUsedThisTurn:0,drawPileCount:48,discardPile:[{id:'discard1',type:'attack'}],turnPhase:'main',matchResult:{status:'ongoing'},players,publicLog:[{type:'insight_played',actor:foe,cardsDrawn:2},{type:'attack_played',actor:seat,target:foe},{type:'dodge_played',actor:foe}]};
  if(phase==='waiting')state.activeSeat=foe;
  if(phase==='discard')state.turnPhase='discard';
  if(phase==='attack')state.pending={kind:'attack_response',attacker:foe,target:seat};
  if(phase==='war_cry'||phase==='arrow_volley')state.pending={kind:'group_response',context:{actor:foe,cardType:phase,requiredResponseType:phase==='war_cry'?'attack':'dodge',queue:[seat]}};
  if(phase==='rescue'||phase==='self_rescue'){const dying=phase==='self_rescue'?seat:foe;state.pending={kind:'dying_rescue',dyingSeat:dying,queue:phase==='self_rescue'?[seat]:[seat,foe],resumeActiveSeat:seat};players.find(p=>p.seat===dying).hp=0;}
  state.deadline={expiresAt:Date.now()+15000,responderSeat:phase==='waiting'?foe:seat};
  return {metadata:{code:'P53AUDIT',mode,status:'active',requiredSeats:count,hostSeat:1,seats:players.map(p=>({seatNumber:p.seat,ready:true})),viewerSeat:seat},state};
}
async function visiblePoint(card) {
  return card.evaluate(el=>{
    const r=el.getBoundingClientRect();
    for(let y=r.top+8;y<r.bottom-5;y+=5)for(let x=r.left+8;x<r.right-5;x+=5){
      const hit=document.elementFromPoint(x,y);
      if(hit && hit.closest('.card')===el && hit.closest('button'))return{x,y};
    }
    throw Error('Card has no reachable exposed face');
  });
}
async function touchPoint(card) {
 return card.evaluate(el=>{const r=el.getBoundingClientRect();const hit=(x,y)=>{const e=document.elementFromPoint(x,y);return e?.closest('.card')===el&&!!e.closest('button')};let best=null,score=-1;for(let y=r.top+12;y<r.bottom-12;y+=5)for(let x=r.left+12;x<r.right-12;x+=5){if(!hit(x,y))continue;let clear=0;for(let d=3;d<=30;d+=3){if([[d,0],[-d,0],[0,d],[0,-d],[d,d],[-d,d],[d,-d],[-d,-d]].every(([dx,dy])=>hit(x+dx,y+dy)))clear=d;else break;}if(clear>score){score=clear;best={x,y};}}if(score<12)throw Error('No 24px touch target');return best;});
}

async function run() {
  await fs.mkdir(out,{recursive:true});
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  const results=[]; const errors=[];
  try{
    const context=await browser.newContext(); let page=await context.newPage();
    page.on('pageerror',e=>errors.push(String(e)));
    let f; let posts=[];
    const routeFixture=route=>{
      const url=route.request().url();
      if(url.endsWith('/events'))return route.abort();
      if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
      return route.fulfill({json:url.endsWith('/state')?{...f.state,deadline:{...f.state.deadline,expiresAt:Date.now()+15000}}:f.metadata});
    };
    await page.route('**/api/card-clash/rooms/**',routeFixture);
    async function open(mode,seat,n,phase){
      f=fixture(mode,seat,n,phase);posts=[];
      await page.goto(base+'/card-clash?room=P53AUDIT');
      await page.waitForSelector('#hand .card');
      await page.mouse.move(2,2);
      await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(im=>im.decode().catch(()=>{})));});
    }
    async function clickCard(c) { let p=await visiblePoint(c); await page.mouse.move(p.x,p.y); await page.waitForTimeout(190); p=await visiblePoint(c); await page.mouse.click(p.x,p.y); }
    const cases=[
      ['normal4','1v1',1,4,'main'],['normal5','1v1',1,5,'main'],['normal6','1v1',1,6,'main'],['seat2','1v1',2,6,'main'],
      ['waiting','1v1',1,6,'waiting'],['target','1v1',1,6,'main'],['discard','1v1',1,6,'discard'],
      ['attack','1v1',1,6,'attack'],['attack-seat2','1v1',2,6,'attack'],['war-cry','1v1',1,6,'war_cry'],['volley','1v1',2,6,'arrow_volley'],
      ['rescue','1v1',1,6,'rescue'],['rescue-seat2','1v1',2,6,'rescue'],['self-rescue','1v1',2,6,'self_rescue'],
      ...[1,2,3,4].map(s=>['2v2-seat'+s,'2v2',s,6,'main']),
      ...[1,2,3].map(s=>['1v2-seat'+s,'1v2',s,5,'main'])
    ];
    for(const [width,height] of sizes){
      await page.setViewportSize({width,height});let resting;
      for(const [name,mode,seat,n,phase] of cases){
        await open(mode,seat,n,phase);
        if(name==='target'){
          const c=page.locator('#hand .card-attack');await clickCard(c);await page.waitForSelector('.card.targeting',{timeout:2500});
        }
        if(name==='discard'){
          const c=page.locator('#hand .card-dodge');await clickCard(c);await page.waitForSelector('.card.selected',{timeout:2500});
        }
        await page.mouse.move(2,2);await page.waitForTimeout(190);
        const m=await page.evaluate(()=>{
          const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
          const hand=document.querySelector('#hand');
          return{viewport:{width:innerWidth,height:innerHeight},scene:rect(document.querySelector('.table-art')),hall:getComputedStyle(document.querySelector('.hall')).display,
            dockBackground:getComputedStyle(document.querySelector('.hand-dock')).backgroundColor,
            hud:rect(document.querySelector('.self-hud')),fan:rect(hand),grips:[...hand.querySelectorAll('.grip-hand')].map(e=>({src:e.getAttribute('src'),pointer:getComputedStyle(e).pointerEvents})),
            cards:[...hand.querySelectorAll('.card')].map(e=>({...rect(e),selected:e.matches('.selected,.targeting'),widthBeforeTransform:e.offsetWidth,position:e.style.cssText})),
            controls:[...document.querySelectorAll('.zone button,.mini-controls button,.topbar a,.far .seat,#countdown')].filter(e=>e.checkVisibility()).map(e=>({id:e.id||e.getAttribute('data-seat')||'station',button:e.matches('button,a'),disabled:!!e.disabled,reachable:e.contains(document.elementFromPoint(e.getBoundingClientRect().x+e.getBoundingClientRect().width/2,e.getBoundingClientRect().y+e.getBoundingClientRect().height/2)),...rect(e)})),
            handCount:document.querySelectorAll('#hand').length,scrollWidth:document.documentElement.scrollWidth};
        });
        assert.equal(m.handCount,1);assert.equal(m.grips.length,2);assert(m.grips.every(g=>g.src.includes('/gauntlet_')&&g.pointer==='none'));
        assert.equal(m.hall,'none');assert.equal(m.dockBackground,'rgba(0, 0, 0, 0)');assert(m.scrollWidth<=width+1);
        assert(m.scene.x<=1&&m.scene.y<=1&&m.scene.right>=width-1&&m.scene.bottom>=height-1,'Scene must cover viewport');
        for(const r of [...m.cards,...m.controls])assert(r.x>=-1&&r.y>=-1&&r.right<=width+1&&r.bottom<=height+1,`${width} ${name}: clipped ${JSON.stringify(r)}`);
        for(const control of m.controls)if(control.button&&!control.disabled&&!control.reachable){await page.screenshot({path:path.join(out,"failure.png")});const blocker=await page.evaluate(r=>document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,400),control);assert.fail(`${width} ${name}: button obscured: ${JSON.stringify(control)} by ${blocker}`);}
        assert(m.cards.every(c=>c.widthBeforeTransform>=80),'Common hands must remain recognisable');
        if(width>=981&&['normal4','normal5','normal6'].includes(name))assert(m.hud.right<=Math.min(...m.cards.map(c=>c.x)),`${width} ${name}: HUD overlaps fan`);
        if(name==='normal6')resting=m.cards.map(c=>c.position);
        if(['waiting','attack','attack-seat2','war-cry','volley','rescue','rescue-seat2'].includes(name))assert.deepEqual(m.cards.map(c=>c.position),resting,'Phase must not change fan geometry');
        for(let i=0;i<n;i++)await visiblePoint(page.locator('#hand .card').nth(i));
        if(['normal4','normal5','normal6','seat2','target','discard','attack','war-cry','rescue','2v2-seat4','1v2-seat1'].includes(name))await page.screenshot({path:path.join(out,`${width}x${height}-${name}.png`)});
        results.push({width,height,name,...m});
      }
      console.log(`Layout cases passed at ${width}x${height}`);
      // Inspect each face with real hover. Check its entire bounds and rules text.
      await open('1v1',1,6,'main');
      for(let i=0;i<6;i++){
        await page.mouse.move(2,2);await page.waitForTimeout(180);
        const c=page.locator('#hand .card').nth(i);const p=await visiblePoint(c);await page.mouse.move(p.x,p.y);await page.waitForTimeout(190);
        const m=await c.evaluate(e=>{const r=e.getBoundingClientRect(),t=e.querySelector('.card-effect');return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,textHeight:t.clientHeight,textScroll:t.scrollHeight};});
        assert(m.left>=0&&m.top>=0&&m.right<=width&&m.bottom<=height,'Inspected card clipped');
        assert(m.textScroll<=m.textHeight+1,`${width} card ${i}: rules text clipped ${JSON.stringify(m)}`);
      }
      await page.screenshot({path:path.join(out,`${width}x${height}-hover.png`)});
      // A real pointer drag: no root rebuild during moves, no inherited easing,
      // correct target highlight, transform follows latest pointer, one POST.
      await open('1v1',1,6,'main');
      let c=page.locator('#hand .card-attack'),p=await visiblePoint(c);
      await page.mouse.move(p.x,p.y);await page.waitForTimeout(190);p=await visiblePoint(c);
      await page.mouse.move(p.x,p.y);await page.mouse.down();
      await page.evaluate(()=>{window.__qaRebuilds=0;window.__qaObserver=new MutationObserver(ms=>window.__qaRebuilds+=ms.filter(m=>m.type==='childList'&&m.target.id==='app').length);window.__qaObserver.observe(document.getElementById('app'),{childList:true});});
      const seat=page.locator('.far .seat[data-seat="2"]');const target=await seat.boundingBox();
      const tx=target.x+target.width/2,ty=target.y+target.height/2;
      await page.mouse.move(tx,ty,{steps:12});await page.waitForTimeout(40);
      assert.equal(await page.locator('.drag-ghost').count(),1);assert(await seat.evaluate(e=>e.classList.contains('drop-ready')));
      await page.evaluate(async()=>window.__cardClash.refresh());
      assert.equal(await page.evaluate(()=>window.__qaRebuilds),0);
      assert.equal(await page.locator('.drag-ghost').count(),1,'Unchanged SSE refresh must preserve drag');
      assert.equal(await page.locator('.drag-ghost').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
      const matrix=await page.locator('.drag-ghost').evaluate(e=>{const m=new DOMMatrix(getComputedStyle(e).transform);return{x:m.m41,y:m.m42}});
      assert(Math.abs(matrix.x-(tx-p.x))<1&&Math.abs(matrix.y-(ty-p.y))<1,'Ghost must follow pointer without easing lag');
      await page.screenshot({path:path.join(out,`${width}x${height}-drag.png`)});
      await page.mouse.up();await page.waitForTimeout(100);assert.equal(posts.length,1);assert.equal(posts[0].type,'play_attack');assert.equal(posts[0].targetSeat,2);assert.equal(await page.locator('.drag-ghost').count(),0);
      // Invalid drop and Escape must clean up and never eat the next click.
      for(const cancel of ['invalid','escape']){
        await open('1v1',1,6,'main');c=page.locator('#hand .card-attack');p=await visiblePoint(c);await page.mouse.move(p.x,p.y);await page.waitForTimeout(190);p=await visiblePoint(c);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(12,45,{steps:8});
        if(cancel==='escape')await page.keyboard.press('Escape');await page.mouse.up();await page.waitForTimeout(250);
        assert.equal(posts.length,0);assert.equal(await page.locator('.drag-ghost').count(),0);assert.equal(await page.locator('body[data-drag]').count(),0);
        p=await visiblePoint(c);await page.mouse.click(p.x,p.y);await page.waitForSelector('.card.targeting');assert.equal(posts.length,0);
      }

      // Playtest regressions: direct cards accept the painted central table,
      // outside the narrow prompt. Each real gesture must submit exactly once.
      for(const type of ['heal','insight','war_cry','arrow_volley']){
        for(const gesture of ['drop','click','cancel-then-click']){
          await open('1v1',1,6,'main');
          f.state.players[0].hand[2].type=type;
          await page.evaluate(()=>window.__cardClash.refresh(true));
          c=page.locator('#cardplay-qa2').locator('..');
          await page.mouse.move(2,2);await page.waitForTimeout(190);
          if(gesture!=='click'){
            p=await visiblePoint(c);await page.mouse.move(p.x,p.y);await page.waitForTimeout(190);p=await visiblePoint(c);
            await page.mouse.move(p.x,p.y);await page.mouse.down();
            if(gesture==='drop'){
              const point=await page.evaluate(()=>{
                const r=document.querySelector('.table-drop-area').getBoundingClientRect();
                for(let y=Math.max(2,r.top+8);y<Math.min(innerHeight-2,r.bottom-8);y+=10)
                  for(let x=Math.max(2,r.left+8);x<Math.min(innerWidth-2,r.right-8);x+=10){
                    const hit=document.elementFromPoint(x,y);
                    if(hit?.closest('.stage')&&!hit.closest('.zone,.far,button,a'))return{x,y};
                  }
                throw Error('No reachable painted-table drop surface');
              });
              await page.mouse.move(point.x,point.y,{steps:10});await page.waitForTimeout(40);
              assert.equal(await page.locator('.table-drop-area.zone-active').count(),1,`${width}: ${type} table not highlighted`);
              await page.mouse.up();
            }else{
              await page.mouse.move(12,45,{steps:8});await page.mouse.up();await page.waitForTimeout(250);
              assert.equal(posts.length,0);await clickCard(c);
            }
          }else await clickCard(c);
          await page.waitForTimeout(100);
          assert.equal(posts.length,1,`${width}: ${type} ${gesture} must need one deliberate action`);
          assert.equal(posts[0].type,'play_'+type);
        }
      }
      await open('1v1',1,5,'discard');
      for(let i=0;i<3;i++)await clickCard(page.locator('#card-qa'+i).locator('..'));
      assert.equal(await page.locator('#card-qa3').isDisabled(),true);
      assert.equal(await page.locator('#card-qa0').isDisabled(),false);
      await clickCard(page.locator('#card-qa0').locator('..'));
      assert.equal(await page.locator('#card-qa3').isDisabled(),false);
      await clickCard(page.locator('#card-qa3').locator('..'));
      await page.locator('#act-discard_cards').click();await page.waitForTimeout(100);
      assert.equal(posts.length,1);assert.equal(posts[0].cardIds.length,3);

      for(const complete of [false,true]){
        await open('1v1',1,6,'main');
        if(complete){f.state.matchResult={status:'complete',winningTeam:'A'};await page.evaluate(()=>window.__cardClash.refresh(true));}
        page.once('dialog',d=>d.accept());
        await page.locator('#return-lobby').click();await page.waitForSelector('#create');
        assert.equal(posts.length,0,'Lobby navigation must not mutate gameplay');
        assert.equal(new URL(await page.locator('#resume-room').getAttribute('href'),base).searchParams.get('room'),'P53AUDIT');
        await page.locator('#resume-room').click();await page.waitForSelector('#hand');
        if(complete)assert.equal(await page.locator('#winner').count(),1);
      }
      console.log(`Direct-card, discard-cap and lobby regressions passed at ${width}x${height}`);

      // Real keyboard alternative and live resize roundtrip (no compounding shrink).
      await open('1v1',1,6,'main');await page.locator('#hand .card-attack button').focus();await page.keyboard.press('Enter');await page.waitForSelector('.card.targeting');
      await page.locator('#target-2').focus();await page.keyboard.press('Enter');await page.waitForTimeout(100);assert.equal(posts.length,1);
      await open('1v1',1,6,'main');
      const widths=await page.locator('#hand .card').evaluateAll(es=>es.map(e=>e.offsetWidth));
      await page.setViewportSize({width:390,height:844});await page.waitForTimeout(60);
      await page.setViewportSize({width,height});await page.waitForTimeout(60);
      assert.deepEqual(await page.locator('#hand .card').evaluateAll(es=>es.map(e=>e.offsetWidth)),widths,'Resizing must not compound card shrink');
      if(width<900){
        const desktopPage=page;
        const touchContext=await browser.newContext({viewport:{width,height},hasTouch:true,isMobile:true});
        page=await touchContext.newPage();page.on('pageerror',e=>errors.push(String(e)));
        await page.route('**/api/card-clash/rooms/**',routeFixture);
        const touch=await touchContext.newCDPSession(page);
        await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
        for(const cancel of [false,true]){
          await open('1v1',1,6,'main');c=page.locator('#hand .card-attack');p=await touchPoint(c);
          const target=await seat.boundingBox();const x=target.x+target.width/2,y=target.y+target.height/2;
          await page.evaluate(()=>{window.__qaTouch=[];for(const t of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.addEventListener(t,e=>window.__qaTouch.push({t,target:e.target.id,button:e.button,primary:e.isPrimary,x:e.clientX,y:e.clientY,pointer:e.pointerType}),true)});
          await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});
          for(let i=1;i<=8;i++){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+(x-p.x)*i/8,y:p.y+(y-p.y)*i/8}]});await page.waitForTimeout(16);}
          assert.equal(await page.locator('.drag-ghost').count(),1,JSON.stringify({width,cancel,p,events:await page.evaluate(()=>window.__qaTouch)}));
          await touch.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await page.waitForTimeout(250);
          assert.equal(posts.length,cancel?0:1);assert.equal(await page.locator('.drag-ghost').count(),0);
        }
        await touch.detach();await touchContext.close();page=desktopPage;
      }
      console.log(`Pointer, keyboard and resize checks passed at ${width}x${height}`);
    }
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(out,'bounds.json'),JSON.stringify(results,null,2));
    await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({browser:await browser.version(),projectionCases:results.length,viewports:sizes,pointerAndKeyboard:'passed at each viewport',touch:'drag and pointercancel passed on both mobile sizes',fixtures:'deterministic filtered projections; real-server smoke is separate',pageErrors:errors},null,2));
    console.log(JSON.stringify({projectionCases:results.length,viewports:sizes,pointerAndKeyboard:'passed',evidence:out}));
  } finally {await browser.close();}
}
module.exports={fixture};
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1});
