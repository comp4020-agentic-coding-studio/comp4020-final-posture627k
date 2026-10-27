// Card copy/rendering regression: externally installed Playwright, no app dependency.
// node scripts/card-clash-readability-browser-check.cjs APP_URL EVIDENCE_DIR PLAYWRIGHT_MODULE
const {chromium}=require(process.argv[4]||process.env.PLAYWRIGHT_MODULE||'playwright');
const {fixture}=require('./card-clash-browser-check.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const base=process.argv[2]||process.env.APP_URL||'http://127.0.0.1:8787';
const out=path.resolve(process.argv[3]||'card-readability-evidence');
const sizes=[[1920,1080],[1366,768],[844,390],[390,844]];
const sets=[['attack','dodge','heal','insight','seize','arrow_volley'],['attack','disarm','war_cry','insight','heal','dodge']];
async function exposed(card){return card.evaluate(e=>{
  const r=e.getBoundingClientRect();
  for(let y=r.top+6;y<r.bottom-5;y+=4)for(let x=r.left+6;x<r.right-5;x+=4){
    const hit=document.elementFromPoint(x,y);
    if(hit?.closest('.card')===e&&hit.closest('button'))return{x,y};
  }
  throw Error('No exposed card button');
});}
async function run(){
  await fs.mkdir(out,{recursive:true});
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const results=[],states=[],errors=[];
  try{
    const page=await browser.newPage();
    page.on('pageerror',e=>errors.push(String(e)));
    let f,posts=[];
    await page.route('**/api/card-clash/rooms/**',route=>{
      if(route.request().url().endsWith('/events'))return route.abort();
      if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
      return route.fulfill({json:route.request().url().endsWith('/state')?f.state:f.metadata});
    });
    async function open(types){
      f=fixture('1v1',1,types.length,'main');posts=[];
      f.state.players[0].hand.forEach((c,i)=>c.type=types[i]);
      f.state.deadline.expiresAt=Date.now()+15000;
      await page.goto(base+'/card-clash?room=P53AUDIT');
      await page.waitForSelector('#hand .card');
      await page.mouse.move(2,2);
      await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));});
      await page.waitForTimeout(220);
    }
    async function measure(card){return card.evaluate(e=>{
      const rule=e.querySelector('.card-effect'),copy=e.querySelector('.effect-copy'),title=e.querySelector('.card-name'),status=e.querySelector('.card-status');
      const style=getComputedStyle(rule),r=e.getBoundingClientRect();
      return {type:e.className,rule:copy.textContent,ruleHeight:rule.clientHeight,ruleScroll:rule.scrollHeight,copyHeight:copy.offsetHeight,ruleFont:parseFloat(style.fontSize),ruleFamily:style.fontFamily,
        title:title.textContent,titleHeight:title.clientHeight,titleScroll:title.scrollHeight,status:status.textContent,statusWidth:status.clientWidth,statusScroll:status.scrollWidth,
        bold:[...copy.querySelectorAll('strong')].map(s=>s.textContent),badge:e.querySelector('.effect-mark')?.textContent,badgePointer:e.querySelector('.effect-mark')&&getComputedStyle(e.querySelector('.effect-mark')).pointerEvents,
        rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};
    });}
    function fits(m,width,height){
      assert(m.ruleScroll<=m.ruleHeight+1&&m.copyHeight<=m.ruleHeight+1,`${width} ${m.type}: clipped rule ${JSON.stringify(m)}`);
      assert(m.titleScroll<=m.titleHeight+1,`${width}: clipped title ${JSON.stringify(m)}`);
      assert(m.statusScroll<=m.statusWidth+1,`${width}: clipped status ${JSON.stringify(m)}`);
      assert(m.rect.left>=-1&&m.rect.top>=-1&&m.rect.right<=width+1&&m.rect.bottom<=height+1,'Card out of viewport');
      if(width>=981){assert(m.ruleFont>=12&&m.ruleFont<=13);assert(m.ruleFamily.includes('Trebuchet'));}
      if(m.badge)assert.equal(m.badgePointer,'none');
    }
    for(const [width,height] of sizes){
      await page.setViewportSize({width,height});
      for(let set=0;set<sets.length;set++){
        await open(sets[set]);
        for(let i=0;i<sets[set].length;i++){
          const card=page.locator('#hand .card').nth(i),m=await measure(card);
          fits(m,width,height);results.push({width,height,set,view:'rest',...m});
        }
        if(set===0)await page.screenshot({path:path.join(out,`${width}-normal6.png`)});
        for(let i=0;i<sets[set].length;i++){
          await page.mouse.move(2,2);await page.waitForTimeout(220);
          const card=page.locator('#hand .card').nth(i),p=await exposed(card);
          await page.mouse.move(p.x,p.y);await page.waitForTimeout(220);
          const m=await measure(card);fits(m,width,height);
          results.push({width,height,set,view:'hover',...m});
          if(width===1366&&['seize','disarm','war_cry'].includes(sets[set][i]))await page.screenshot({path:path.join(out,`${width}-${sets[set][i]}-hover.png`)});
        }
      }
      await open(sets[0]);
      async function update(label,mutate,type,expected){
        mutate(f.state);f.state.version++;await page.evaluate(()=>window.__cardClash.refresh(true));
        const card=page.locator('.card-'+type);
        assert.equal(await card.locator('.card-status').textContent(),expected);
        await page.mouse.move(2,2);await page.waitForTimeout(220);
        const m=await measure(card);fits(m,width,height);states.push({width,height,label,...m});
      }
      await update('full-hp',s=>{s.players[0].hp=s.players[0].maxHp;},'heal','Full HP');
      await update('attack-limit',s=>{s.normalAttacksUsedThisTurn=1;},'attack','Attack limit used');
      await update('empty-hands',s=>{s.players[1].handSize=0;},'seize','Empty hands');
      await update('attack-response',s=>{s.pending={kind:'attack_response',attacker:2,target:1};},'dodge','Play Dodge');
      await update('needs-dodge',()=>{},'heal','Needs Dodge');
      await update('group-response',s=>{s.pending={kind:'group_response',context:{actor:2,cardType:'war_cry',requiredResponseType:'attack',queue:[1]}};},'attack','Play Attack');
      await update('rescue',s=>{s.players[1].hp=0;s.pending={kind:'dying_rescue',dyingSeat:2,queue:[1,2],resumeActiveSeat:1};},'heal','Play Heal');
      await update('waiting-response',s=>{s.pending={kind:'attack_response',attacker:1,target:2};},'dodge','Wait for seat 2');
      await update('waiting-turn',s=>{delete s.pending;s.activeSeat=2;},'insight','Wait for turn');
      await update('complete',s=>{s.matchResult={status:'complete',winningTeam:'A'};},'attack','Match over');
      assert.equal(posts.length,0,'Rendering explanations must not submit actions');
      console.log(`Copy, emphasis, all eight faces, and availability labels passed at ${width}x${height}`);
    }
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(out,'measurements.json'),JSON.stringify({faces:results,states},null,2));
    await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({browser:await browser.version(),viewports:sizes,faceMeasurements:results.length,contextMeasurements:states.length,pageErrors:errors,fixtures:'filtered deterministic projections with real running page/assets; no human acceptance'},null,2));
  }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1});