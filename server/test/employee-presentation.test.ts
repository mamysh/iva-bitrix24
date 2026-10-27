import {test} from 'node:test';
import assert from 'node:assert/strict';
import {candidatePresentation} from '../src/employee-presentation.ts';
test('department labels stay short, identity lives in the choice, source text cannot inject buttons',()=>{
 const result=candidatePresentation('departments',[{id:203,name:'Design <tg-button>',path:'Parent / Design & research'},{id:205,name:'Production design',path:'Other / Production design'}],false);
 assert.deepEqual(result.options.map(v=>v.label),['Отдел 1','Отдел 2','Отмена']);
 assert.match(result.markdown,/1\. \*\*Design &lt;tg\\-button&gt;/);
 assert.match(result.markdown,/data="Выбрать отдел ID 203">Отдел 1/);
 assert.match(result.markdown,/Поиск ещё не завершён/);assert.ok(result.markdown.includes('\n\n'));
 assert.equal(result.choiceIsApproval,false);assert.ok(!result.markdown.includes('<tg-button>'));
});
test('long department paths are split into cards without losing their identity or path',()=>{
 const items=Array.from({length:10},(_,i)=>({id:i+1,name:'Design',path:('Hierarchy / ').repeat(100)+String(i)}));
 const result=candidatePresentation('departments',items,true);assert.ok(result.pages.length>1);
 for(const p of result.pages)assert.ok(p.markdown.length<4096);
 assert.equal(result.pages.flatMap(p=>p.options.filter(v=>v.id!=='cancel')).length,10);
 for(const v of items)assert.ok(result.pages.some(p=>p.markdown.includes(v.path)));
});
