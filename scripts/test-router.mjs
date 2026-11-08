import ts from 'typescript';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const output=ts.transpileModule(readFileSync(new URL('../src/routing.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const context={exports:{},structuredClone};vm.runInNewContext(output,context);
const {classify,route,withDefaults,handoffText,destKey}=context.exports;
const cfg=withDefaults(null);
assert.equal(classify('Oi',cfg).level,'leve');
assert.equal(classify('muda a cor do botão de salvar pra verde',cfg).level,'leve');
assert.equal(classify('corrige o filtro de data em src/App.tsx para aceitar intervalo vazio e mostrar aviso',cfg).level,'medio');
assert.equal(classify('refatora o sistema de sessões',cfg).level,'pesado');
assert.equal(classify('ajusta a.ts, b.ts e c.rs',cfg).level,'pesado');
const usage=(p,used)=>[{provider:p,plan:null,error:null,windows:[{label:'Sessão',used,resets_at:null},{label:'Semanal',used:10,resets_at:null}]}];
// leve vai pro Antigravity; com ele acima do teto, cai pro próximo da lista
assert.equal(route('Oi',cfg,null).target.provider,'antigravity');
const r=route('Oi',cfg,usage('antigravity',95));
assert.equal(r.target.provider,'codex');
assert.match(r.skipped[0].why,/95%/);
assert.equal(route('Oi',cfg,null,'pesado').target.provider,'claude');
assert.equal(route('Oi',cfg,null,undefined,['antigravity:']).target.provider,'codex');
const off=withDefaults({providers:{claude:{enabled:false,ceiling:85,weeklyCeiling:90}}});
assert.equal(route('refatora tudo',off,null).target.provider,'codex');
assert.match(handoffText('claude','passagem manual','faz X',[{role:'user',text:'faz X'},{role:'tool',text:'Bash'},{role:'assistant',text:'feito metade'}],cfg),/Agente: feito metade/);
// passagens seguidas não voltam para quem já pegou a tarefa
assert.equal(route('Oi',cfg,null,undefined,['antigravity:','codex:']).target.provider,'claude');
assert.equal(route('Oi',cfg,null,undefined,['antigravity:','codex:','claude:']).target,null);
// nível sem nenhum provider configurado
assert.equal(route('Oi',withDefaults({levels:{leve:[],medio:cfg.levels.medio,pesado:cfg.levels.pesado}}),null).target,null);
// teto semanal também barra
assert.match(route('refatora',cfg,[{provider:'claude',plan:null,error:null,windows:[{label:'Sessão',used:10,resets_at:null},{label:'Semanal',used:92,resets_at:null}]}]).skipped[0].why,/semanal/);
// duas contas do Claude: a principal no teto passa para a extra, que tem cota própria
const two=withDefaults({levels:{...cfg.levels,pesado:[{provider:'claude',model:'opus',effort:'high'},{provider:'claude',model:'opus',effort:'high',account:'trabalho'}]}});
const u2=[{provider:'claude',plan:null,error:null,windows:[{label:'Sessão',used:95,resets_at:null}]},{provider:'claude',account:'trabalho',plan:null,error:null,windows:[{label:'Sessão',used:10,resets_at:null}]}];
assert.equal(route('refatora',two,u2).target.account,'trabalho');
assert.equal(route('refatora',two,null,undefined,['claude:']).target.account,'trabalho');
assert.equal(destKey({provider:'claude',account:'trabalho'}),'claude:trabalho');
// rodízio: só a principal configurada, mas há uma conta extra com cota sobrando
const uMain=[{provider:'claude',plan:null,error:null,windows:[{label:'Sessão',used:95,resets_at:null}]},{provider:'claude',account:'trabalho',plan:null,error:null,windows:[{label:'Sessão',used:10,resets_at:null}]}];
const rot=route('refatora',cfg,uMain,undefined,[],[undefined,'trabalho']);
assert.equal(rot.target.provider,'claude');
assert.equal(rot.target.account,'trabalho');
assert.equal(rot.target.model,'opus');
const noRot=route('refatora',withDefaults({rotateAccounts:false}),uMain,undefined,[],[undefined,'trabalho']);
assert.equal(noRot.target.provider,'codex');
console.log('router ok');
