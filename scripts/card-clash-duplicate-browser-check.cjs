// Real Chromium duplicate-card selection regression.
// Pass the isolated APP_URL and output folder as arguments. Requires the same
// external Playwright runtime as card-clash-browser-check.cjs.
process.env.PLAYWRIGHT_MODULE=process.argv[4]||process.env.PLAYWRIGHT_MODULE;
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {fixture}=require('./card-clash-browser-check.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const base=process.argv[2]||process.env.APP_URL;
const out=path.resolve(process.argv[3]||'duplicate-card-evidence');
async function run(){
 await fs.mkdir(out,{recursive:true});const browser=await chromium.launch({channel:'chrome',headless:true});
 const results=[],errors=[];
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
  let f,posts=[];
  await page.route('**/api/card-clash/rooms/**',route=>{
   if(route.request().url().endsWith('/events'))return route.abort();
   if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
   return route.fulfill({json:route.request().url().endsWith('/state')?f.state:f.metadata});
  });
  async function point(card){return card.evaluate(el=>{const r=el.getBoundingClientRect();for(let y=r.top+10;y<r.bottom-5;y+=5)for(let x=r.left+8;x<r.right-5;x+=5){const hit=document.elementFromPoint(x,y);if(hit?.closest('.card')===el&&hit.closest('button'))return{x,y};}throw Error('No reachable card face');});}
  async function click(id){const c=page.locator('#'+id).locator('..');let p=await point(c);await page.mouse.move(p.x,p.y);await page.waitForTimeout(180);p=await point(c);await page.mouse.click(p.x,p.y);await page.mouse.move(1,1);await page.waitForTimeout(180);}
  async function selected(){return page.locator('#hand .card.targeting button').evaluateAll(es=>es.map(e=>e.id));}
  for(const [width,height] of [[1920,1080],[1366,768],[844,390],[390,844]]){
   await page.setViewportSize({width,height});f=fixture('1v1',1,6,'main');posts=[];
   f.state.publicLog=[];
   f.state.players[0].hand=['attack','attack','seize','seize','disarm','disarm'].map((type,i)=>({id:'dup'+i,type}));
   await page.goto(base+'/card-clash?room=P53AUDIT');await page.waitForSelector('#cardplay-dup0');await page.mouse.move(1,1);
   const baseline=await page.locator('#hand .card').evaluateAll(es=>es.map(e=>getComputedStyle(e).transform));
   for(const [type,offset] of [['attack',0],['seize',2],['disarm',4]]){
    const first='cardplay-dup'+offset,second='cardplay-dup'+(offset+1);
    await click(first);assert.deepEqual(await selected(),[first]);
    assert.equal(await page.locator('#'+first).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#'+second).getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#'+second).locator('..').evaluate(e=>getComputedStyle(e).transform),baseline[offset+1],'Unchosen duplicate should stay in the resting fan');
    await click(second);assert.deepEqual(await selected(),[second]);
    assert.equal(await page.locator('#'+first).locator('..').evaluate(e=>getComputedStyle(e).transform),baseline[offset],'Previous selection should return to its fan position');
    await page.evaluate(()=>window.__cardClash.refresh(true));assert.deepEqual(await selected(),[second]);
    if(type==='attack')await page.screenshot({path:path.join(out,`${width}-second-attack-selected.png`)});
    await page.locator('#'+first).focus();await page.keyboard.press('Enter');assert.deepEqual(await selected(),[first]);
    await page.keyboard.press('Enter');assert.deepEqual(await selected(),[]);
    await page.locator('details.fallback summary').click();await page.locator('#act-play_'+type).click();
    assert.deepEqual(await selected(),[first]);
    await page.locator('#cancel-target').click();assert.deepEqual(await selected(),[]);
    assert.equal(posts.length,0,'Selection changes must not submit gameplay');
    results.push({viewport:[width,height],type,mouse:'choose/switch passed',keyboard:'switch/toggle passed',restingDuplicate:'unchanged',quickActions:'one matching card selected',cancel:'cleared',unchangedRefresh:'preserved'});
   }
   await click('cardplay-dup5');await page.locator('#target-2').click();
   await page.waitForFunction(()=>document.querySelectorAll('#hand .card.targeting').length===0);
   assert.equal(posts.length,1);assert.equal(posts[0].type,'play_disarm');assert.equal(posts[0].targetSeat,2);
   console.log(`Duplicate-card selection passed at ${width}x${height}`);
  }
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({browser:await browser.version(),cases:results,fixtures:'Deterministic filtered projections rendered with the real page and assets',pageErrors:errors},null,2));
 }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1});
