// Real Chromium novice guidance checks; uses the existing external Playwright runtime.
// APP_URL=http://127.0.0.1:8823 PLAYWRIGHT_MODULE=/path/to/playwright node scripts/card-clash-novice-browser-check.cjs /tmp/evidence
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture}=require(process.env.CARD_CLASH_BROWSER_HELPERS||'./card-clash-browser-check.cjs');
const base=process.env.APP_URL||'http://127.0.0.1:8823';
const out=path.resolve(process.argv[2]||'novice-browser-evidence');
async function run(){
 await fs.mkdir(out,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const records=[],errors=[];
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
  let f,posts=[];
  await page.route('**/api/card-clash/rooms/**',route=>{
   if(route.request().url().endsWith('/events'))return route.abort();
   if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
   return route.fulfill({json:route.request().url().endsWith('/state')?f.state:f.metadata});
  });
  for(const [width,height] of [[1920,1080],[1366,768],[844,390],[390,844]]){
   await page.setViewportSize({width,height});
   f=fixture('2v2',4,5,'main');f.metadata.status='waiting';
   await page.goto(base+'/card-clash?room=P53AUDIT');
   await page.waitForSelector('#quick-start-title');
   assert.equal(await page.locator('.quick-start .learn-step').count(),4);
   assert.match(await page.locator('.quick-start .team-overview').innerText(),/seat 4.*Team A/);
   await page.locator('.quick-start .card-reference summary').click();
   assert.equal(await page.locator('.quick-start .reference-card:visible').count(),8);
   await page.screenshot({path:path.join(out,`${width}-preparation.png`),fullPage:false});
   for(const seat of [1,2,3,4]){
    f=fixture('2v2',seat,6,'main');posts=[];
    await page.goto(base+'/card-clash?room=P53AUDIT');
    await page.waitForSelector('#help-open');
    await page.mouse.move(1,1);await page.waitForTimeout(200);
    const identity=await page.locator('#team-identity').innerText();
    assert.match(identity,seat===1||seat===4?/Team A \(Red\)/:/Team B \(Blue\)/);
    assert.equal(await page.locator('.far .relationship').filter({hasText:'Ally'}).count(),1);
    assert(await page.locator('.far .relationship').filter({hasText:'Ally'}).isVisible());
    assert.equal(await page.locator('.far .relationship').filter({hasText:'Opponent'}).count(),2);
    const layout=await page.evaluate(()=>{
     const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
     const controls=[...document.querySelectorAll('#help-open,#return-lobby')].map(e=>({...rect(e),id:e.id,reachable:e.contains(document.elementFromPoint(e.getBoundingClientRect().x+e.getBoundingClientRect().width/2,e.getBoundingClientRect().y+e.getBoundingClientRect().height/2))}));
     return{controls,guide:rect(document.querySelector('#decision-guide')),cards:[...document.querySelectorAll('#hand .card')].map(rect),scrollWidth:document.documentElement.scrollWidth};
    });
    assert(layout.scrollWidth<=width+1);
    for(const c of layout.controls){assert(c.height>=44);assert(c.x>=0&&c.right<=width&&c.reachable,JSON.stringify(c));}
    const stations=await page.locator('.far .seat').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}}));
    for(const station of stations)assert(!(layout.guide.x<station.right&&layout.guide.right>station.left&&layout.guide.y<station.bottom&&layout.guide.bottom>station.top),'Main guidance overlaps an opponent station');
    if(seat===1)await page.screenshot({path:path.join(out,`${width}-normal6.png`)});
    const expires=await page.locator('#countdown').getAttribute('data-expires');
    await page.locator('#help-open').click();
    assert(await page.locator('#game-help').evaluate(e=>e.open));
    assert.match(await page.locator('#help-context').innerText(),/Your turn/);
    const clock=await page.locator('#help-clock').innerText();
    await page.waitForTimeout(600);
    assert.notEqual(await page.locator('#help-clock').innerText(),clock);
    assert.equal(await page.locator('#countdown').getAttribute('data-expires'),expires);
    await page.keyboard.press('Shift+Tab');
    assert(await page.locator('#game-help').evaluate(e=>e.contains(document.activeElement)));
    await page.locator('#game-help .card-reference summary').click();
    assert.equal(await page.locator('#game-help .reference-card:visible').count(),8);
    for(const phase of ['attack','war_cry','arrow_volley','rescue','discard','waiting']){
     const next=fixture('2v2',seat,6,phase);
     next.state.version=f.state.version+1;
     if(phase==='attack')next.state.activeSeat=seat===1?2:1;
     f=next;
     await page.evaluate(()=>window.__cardClash.refresh());
     const expected=phase==='attack'?'must respond — Attack':phase==='war_cry'?'must respond — War Cry':phase==='arrow_volley'?'must respond — Arrow Volley':phase==='rescue'?'may rescue':phase==='discard'?'discard 4 cards':'is playing — wait';
     await page.waitForFunction(text=>document.querySelector('#help-context').textContent.includes(text),expected);
     assert(await page.locator('#game-help').evaluate(e=>e.open));
     assert(await page.locator('#game-help .card-reference').evaluate(e=>e.open));
     assert.equal(posts.length,0,'Help must not submit actions');
     if(seat===1&&phase==='attack'){await page.keyboard.press('Escape');await page.screenshot({path:path.join(out,`${width}-response.png`)});await page.locator('#help-open').click();}
    }
    if(seat===1)await page.screenshot({path:path.join(out,`${width}-help.png`)});
    await page.keyboard.press('Escape');
    assert(!await page.locator('#game-help').evaluate(e=>e.open));
    await page.waitForFunction(()=>document.activeElement===document.getElementById('help-open'),null,{timeout:2500});
    await page.locator('#help-open').click();await page.locator('#help-close').click();
    await page.waitForFunction(()=>document.activeElement===document.getElementById('help-open'),null,{timeout:2500});
    // Native confirmation: cancel stays in the room; accept follows the
    // existing resume link. Both active and completed matches use the flow.
    for(const done of [false,true]){
     if(done){f.state={...f.state,version:f.state.version+1,matchResult:{status:'complete',winningTeam:'A'}};await page.evaluate(()=>window.__cardClash.refresh());await page.waitForSelector('#winner');}
     page.once('dialog',d=>d.dismiss());await page.locator('#return-lobby').click();
     assert(page.url().includes('?room='));
     page.once('dialog',d=>d.accept());await page.locator('#return-lobby').click();
     await page.waitForURL('**/card-clash?resume=P53AUDIT');
     await page.locator('#resume-room').click();await page.waitForSelector('#hand');
    }
    records.push({viewport:[width,height],seat,identity,layout,help:'live context, continuing clock, Escape, close and focus return passed',lobby:'cancel/accept/resume passed for active and completed matches',posts:posts.length});
   }
   console.log(`Novice Help and team verification passed at ${width}x${height}`);
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({browser:await browser.version(),fixtures:'deterministic filtered projections; no human acceptance claimed',records,pageErrors:errors},null,2));
 }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1});
