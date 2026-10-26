import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {protectionFixture} from './test-support/protection-fixture.mjs';
const project=path.resolve(import.meta.dirname,'..');
const f=await protectionFixture(project);
const before=await f.config();
const review=await f.cli(['protection','prepare']);
assert.equal(review.trusted,false); assert.equal(await f.config(),before);
const result=await f.cli(['protection','enable','--review',review.reviewId,'--yes']);
assert.equal(result.trusted,true);
// Each CLI command owns an independent official App Server process.
assert.equal((await f.cli(['protection','status'])).trusted,true);
const manifest=review.details[0].source;
const content=JSON.parse(await readFile(manifest,'utf8'));
content.hooks.hooks.Stop[0].hooks[0].statusMessage='Changed fixture definition';
await writeFile(manifest,JSON.stringify(content));
assert.equal((await f.cli(['protection','status'])).trusted,false);
console.log(JSON.stringify({ok:true,actualCodex:true,initialUntrusted:true,cancelNoWrite:true,
  confirmedTrusted:true,restartStillTrusted:true,definitionChangeRequiresReview:true,
  productionConfigTouched:false,quotaSpent:0,evidence:f.root}));
