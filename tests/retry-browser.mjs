// Browser plugin not available; test the real extension in a disposable Playwright profile.
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { RETRY_PANEL_VERSION } from '../src/retry-panel.mjs';

const profile=await mkdtemp(path.join(tmpdir(),'canvas-retry-check-'));
const extension=path.resolve(import.meta.dirname,'../extension');
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1360,height:960},
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const page=await context.newPage();const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const html=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>重试面板验证</title></head><body>
<main>
 <div data-node-id="first"><button data-retry="first">重试</button></div>
 <div data-node-id="second"><button data-retry="second">重试</button></div>
 <div data-node-id="collapsed"><button aria-label="图片组已收起">展开</button><div data-node-id="collapsed-child"><button data-retry="collapsed">重试</button></div></div>
 <div data-node-id="expanded"><button aria-label="图片组已展开">收起</button><div data-node-id="expanded-child"><button data-retry="expanded">重试</button></div></div>
 <div data-node-id="disabled"><button data-retry="disabled" disabled>重试</button></div>
</main><script>window.retryCounts={};document.addEventListener('click',event=>{const id=event.target.dataset.retry;if(id)window.retryCounts[id]=(window.retryCounts[id]||0)+1;});</script>
</body></html>`;
try {
  await page.route('https://canvas.modelaryx.com/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://canvas.modelaryx.com/canvas/retry-fixture');
  const panel=page.locator('#local-canvas-retry-panel');
  await panel.getByRole('button',{name:'重试当前失败项（3）',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.retryCounts),{});
  assert.equal(await panel.getAttribute('data-version'),RETRY_PANEL_VERSION);
  await panel.getByRole('button',{name:'自动重试',exact:true}).waitFor();
  await panel.getByRole('button',{name:'取消重试',exact:true}).waitFor();
  console.log('PASS: panel loads automatically; no generation is submitted on page load');
  await page.addScriptTag({path:path.join(extension,'guard.js')});
  assert.equal(await panel.count(),1);
  await page.reload();
  await panel.getByRole('button',{name:'重试当前失败项（3）',exact:true}).waitFor();
  console.log('PASS: reinjection does not duplicate the panel; refresh restores it');
  await panel.getByLabel('逐项提交间隔（秒）').fill('0.2');
  await panel.getByRole('button',{name:'重试当前失败项（3）',exact:true}).click();
  await page.waitForFunction(()=>window.retryCounts.expanded===1);
  await page.waitForFunction(()=>document.getElementById('local-canvas-retry-panel').shadowRoot.getElementById('status').textContent.includes('本轮提交结束'));
  assert.deepEqual(await page.evaluate(()=>window.retryCounts),{first:1,second:1,expanded:1});
  assert.match(await panel.locator('#status').innerText(),/本轮提交结束/);
  console.log('PASS: each actionable failure is submitted once; collapsed and disabled failures are skipped');
  assert.equal(await panel.locator('#stop').count(),0);
  console.log('PASS: the manual section contains its single retry action');
  await panel.getByRole('button',{name:'收起批量重试工具',exact:true}).click();
  assert.equal(await panel.getByRole('button',{name:'重试',exact:true}).isVisible(),true);
  assert.equal(await panel.getByRole('button',{name:'自动重试',exact:true}).isVisible(),false);
  await panel.getByRole('button',{name:'展开批量重试设置',exact:true}).click();
  await page.locator('#canvas-save-guard').getByRole('button',{name:'收起重试工具',exact:true}).click();
  assert.equal(await panel.isVisible(),false);
  await page.locator('#canvas-save-guard').getByRole('button',{name:'显示重试工具',exact:true}).click();
  assert.equal(await panel.isVisible(),true);
  const retryBox=await panel.boundingBox(),guardBox=await page.locator('#canvas-save-guard').boundingBox();
  assert.ok(retryBox.y+retryBox.height<=guardBox.y);
  console.log('PASS: collapsed view exposes retry and expand buttons; expanding restores settings; show/hide and save-control layout work');
  await page.evaluate(()=>history.pushState({},'','/canvas'));
  await page.waitForFunction(()=>document.getElementById('local-canvas-retry-panel').hidden);
  await page.evaluate(()=>{document.getElementById('local-canvas-retry-panel').remove();history.pushState({},'','/canvas/another-fixture');});
  await panel.getByRole('button',{name:'重试当前失败项（3）',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: SPA navigation hides/restores the panel and repairs a removed mount; no runtime errors');
} catch(error) {
  console.log(JSON.stringify(await page.evaluate(()=>({url:location.href,body:document.body.innerText,panel:document.getElementById('local-canvas-retry-panel')?.shadowRoot?.textContent,version:document.getElementById('local-canvas-retry-panel')?.dataset.version}))),errors);
  throw error;
} finally {
  await context.close();
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir())+path.sep));
  await rm(profile,{recursive:true,force:true});
}
