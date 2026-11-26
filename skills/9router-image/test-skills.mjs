import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), '9router-skill-tests-'));
const env = { ...process.env };
for (const key of ['NINEROUTER_URL', 'NINEROUTER_KEY', 'NINEROUTER_PROVIDER', 'OPENCODE_CONFIG']) delete env[key];
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('OK ' + name); };
const config = path.join(work, 'opencode.jsonc');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=', 'base64');
const settings = (baseURL, apiKey) => ({ providers: { '9router': { settings: { baseURL, apiKey } } } });
const sources = {};
let server;
let nativeServer;
try {
  for (const platform of ['windows', 'linux']) {
    const skill = readFileSync(path.join(root, platform, 'SKILL.md'), 'utf8');
    const resolve = platform === 'windows' ? skill.match(/\$resolver = @'\n([\s\S]*?)\n'@/)[1] : skill.match(/CONNECTION=\$\(node - "\$CFG" <<'JS'\n([\s\S]*?)\nJS/)[1];
    const save = platform === 'windows' ? skill.match(/\$save = @'\n([\s\S]*?)\n'@/)[1] : skill.match(/node - "\$WORK\/response.bin" "generated" <<'JS'\n([\s\S]*?)\nJS/)[1];
    sources[platform] = { resolve, save };
    const run = (value, overrides = {}) => {
      writeFileSync(config, typeof value === 'string' ? value : JSON.stringify(value));
      return spawnSync(process.execPath, ['-', config], { input: resolve, env: { ...env, ...overrides }, encoding: 'utf8' });
    };
    const success = (value, expected, overrides = {}) => {
      const r = run(value, overrides);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), expected);
    };
    const fail = (value, overrides = {}) => {
      const r = run(value, overrides);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.ok(!r.stderr.includes('SECRET'));
    };
    check(platform + ': JSONC preserves comments/commas inside strings and BOM', () => {
      const key = 'SECRET,} // /* \\" apostrophe \' $tick';
      const value = '\ufeff{ /* before */ "providers":{"9router":{"settings":' + JSON.stringify({ baseURL: 'https://host.test/prefix/v1///', apiKey: key }) + ',},}, // tail\n}';
      success(value, { base: 'https://host.test/prefix/v1', key });
    });
    check(platform + ': plugin-only install', () => success({plugins:[{package:'@joaogsbarbosa/opencode-9router@latest',options:{baseURL:'http://localhost:20128',apiKey:'test'}}]}, {base:'http://localhost:20128/v1',key:'test'}));
    check(platform + ': multigateway options precede stale settings', () => success({plugins:[{package:'@joaogsbarbosa/opencode-9router',options:{providers:[{key:'other',baseURL:'https://other.test',apiKey:'other'},{key:'9router',baseURL:'https://chosen.test/v1/v1/',apiKey:'chosen'}]}}],...settings('https://stale.test','stale')}, {base:'https://chosen.test/v1',key:'chosen'}));
    check(platform + ': explicit gateway selection', () => success({plugins:[{package:'@joaogsbarbosa/opencode-9router',options:{providers:[{id:'a',baseURL:'https://a.test'},{id:'b',baseURL:'https://b.test',apiKey:'b'}]}}]}, {base:'https://b.test/v1',key:'b'}, {NINEROUTER_PROVIDER:'b'}));
    check(platform + ': ambiguous targets stop', () => fail({plugins:[{package:'@joaogsbarbosa/opencode-9router',options:{providers:[{key:'a'},{key:'b'}]}}]}));
    check(platform + ': prefixed provider and noAuth', () => success({providers:{'9router-local':{settings:{baseURL:'http://localhost:20128/'}}}}, {base:'http://localhost:20128/v1',key:''}));
    check(platform + ': environment overrides broken config', () => success('{SECRET', {base:'https://override.test/v1',key:''}, {NINEROUTER_URL:'https://override.test/',NINEROUTER_KEY:''}));
    check(platform + ': partial override retains matching key', () => success(settings('https://host.test','test-key'), {base:'https://override.test/v1',key:'test-key'}, {NINEROUTER_URL:'https://override.test'}));
    check(platform + ': env references', () => success(settings('{env:TEST_ROUTER_BASE}','{env:TEST_ROUTER_KEY}'), {base:'https://env.test/proxy/v1',key:'ref'}, {TEST_ROUTER_BASE:'https://env.test/proxy',TEST_ROUTER_KEY:'ref'}));
    check(platform + ': relative file reference', () => {
      writeFileSync(path.join(work,'key.txt'),'file-key\n');
      success(settings('https://host.test','{file:key.txt}'),{base:'https://host.test/v1',key:'file-key'});
    });
    check(platform + ': missing env reference stops', () => fail(settings('https://host.test','{env:MISSING_9ROUTER_TEST_REFERENCE}')));
    check(platform + ': malformed JSONC hides secret fragments', () => fail('{"SECRET": }'));
    check(platform + ': rejects URL credentials/query/fragment/protocol', () => {
      for(const url of ['https://user:SECRET@host.test','https://host.test?SECRET=1','https://host.test/#SECRET','file:///SECRET']) fail(settings(url,''));
    });
    check(platform + ': header injection stops', () => fail(settings('https://host.test','SECRET\r\ninjected: x')));
    check(platform + ': unrelated plugins are ignored', () => fail({plugins:[{package:'unrelated-9router-plugin',options:{baseURL:'https://host.test',apiKey:'SECRET'}}]}));
    const reply = path.join(work, platform + '-response.bin');
    const output = path.join(work, platform + '-images');
    const runSave = value => {
      writeFileSync(reply, Buffer.isBuffer(value) ? value : JSON.stringify(value));
      return spawnSync(process.execPath, ['-',reply,output], {input:save,env,encoding:'utf8'});
    };
    check(platform + ': binary PNG under 1 KB saves with actual extension', () => {
      const r=runSave(image); assert.equal(r.status,0,r.stderr);
      const files=r.stdout.trim().split(/\r?\n/); assert.equal(files.length,1); assert.ok(files[0].endsWith('.png')); assert.deepEqual(readFileSync(files[0]),image);
    });
    check(platform + ': HTTP 200 JSON fallback saves ALL base64/data-URI images', () => {
      const r=runSave({data:[{b64_json:image.toString('base64')},{url:'data:image/png;base64,'+image.toString('base64')}]}); assert.equal(r.status,0,r.stderr); assert.equal(r.stdout.trim().split(/\r?\n/).length,2);
    });
    check(platform + ': repeated saves never overwrite', () => {
      const before=readdirSync(output).length; runSave(image); runSave(image); assert.equal(readdirSync(output).length,before+2);
    });
    check(platform + ': errors and empty/invalid payloads never succeed', () => {
      for(const payload of [{error:{message:'SECRET'}},{data:[]},{data:[{b64_json:''}]},{data:[{b64_json:'!invalid'}]},Buffer.from('<html>SECRET</html>')]) {
        const before=readdirSync(output).length; const r=runSave(payload); assert.equal(r.status,1); assert.equal(r.stdout,''); assert.ok(!r.stderr.includes('SECRET')); assert.equal(readdirSync(output).length,before);
      }
    });
    check(platform + ': partial results are preserved and failure is reported', () => {
      const r=runSave({data:[{b64_json:image.toString('base64')},{url:'file:///SECRET'}]}); assert.equal(r.status,1); assert.equal(r.stdout.trim().split(/\r?\n/).length,1); assert.ok(!r.stderr.includes('SECRET'));
    });
  }
  check('platforms execute identical resolver and saver logic', () => assert.deepEqual(sources.windows,sources.linux));
  // Exercise the real downloader against a local mock, including redirects and auth isolation.
  let leaked = false;
  server=createServer((req,res)=>{
    if(req.headers.authorization) leaked=true;
    if(req.url==='/redirect'){res.writeHead(302,{location:'/image'});res.end();}
    else if(req.url==='/image'){res.writeHead(200,{'content-type':'image/png'});res.end(image);}
    else {res.writeHead(404);res.end('SECRET');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const reply=path.join(work,'download.json');
  const output=path.join(work,'downloads');
  writeFileSync(reply,JSON.stringify({data:[{url:'http://127.0.0.1:'+port+'/redirect'},{url:'http://127.0.0.1:'+port+'/missing'}]}));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-',reply,output],{env:{...env,NINEROUTER_KEY:'SECRET'}}); let stdout='',stderr='';
    child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c); child.on('error',reject); child.on('close',status=>resolve({status,stdout,stderr})); child.stdin.end(sources.linux.save);
  });
  check('download follows redirect, reports partial failure, never sends gateway key',()=>{assert.equal(result.status,1);assert.equal(leaked,false);assert.equal(result.stdout.trim().split(/\r?\n/).length,1);assert.ok(!result.stderr.includes('SECRET'));});

  // Run the actual shell wrappers with Unicode prompts against a local gateway mock.
  const requests=[];
  let gatewayStatus=200;
  nativeServer=createServer((req,res)=>{
    let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{
      try { requests.push({url:req.url,auth:req.headers.authorization,body:JSON.parse(body)}); }
      catch { res.writeHead(400); res.end(); return; }
      if(gatewayStatus!==200){res.writeHead(gatewayStatus,{'content-type':'application/json','retry-after':'120'});res.end(JSON.stringify({error:{message:'synthetic unavailable'}}));return;}
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({data:[{b64_json:image.toString('base64')},{b64_json:image.toString('base64')}]}));
    });
  });
  await new Promise(resolve=>nativeServer.listen(0,'127.0.0.1',resolve));
  writeFileSync(config,JSON.stringify(settings('http://127.0.0.1:'+nativeServer.address().port,'test-gateway-key')));
  const prompt="ação d'água $dollar \"quoted\" "+String.fromCharCode(96)+'tick';
  for(const platform of ['windows','linux']) {
    const skill=readFileSync(path.join(root,platform,'SKILL.md'),'utf8');
    const blocks=[...skill.matchAll(platform==='windows'?/\x60{3}powershell\n([\s\S]*?)\n\x60{3}/g:/\x60{3}bash\n([\s\S]*?)\n\x60{3}/g)].map(m=>m[1]);
    const windows=platform==='windows';
    const executable=windows?'powershell.exe':process.platform==='win32'?path.join(env.ProgramFiles || 'C:/Program Files','Git/bin/bash.exe'):'/bin/sh';
    if(windows && process.platform!=='win32') { console.log('SKIP Windows shell integration on non-Windows host'); continue; }
    if(!windows && !existsSync(executable)) { console.log('SKIP POSIX shell integration: shell unavailable'); continue; }
    const script=path.join(work,windows?'native.ps1':'native.sh');
    const setup=windows?"$model='test/image'; $prompt=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+Buffer.from(prompt).toString('base64')+"'))\n":'';
    let request=blocks[2];
    if(!windows) request=request.replace('{"model":"<replace-with-discovered-id>","prompt":"watercolor mountains at sunrise","n":1}',JSON.stringify({model:'test/image',prompt,n:1}));
    // This also verifies the JSON fallback path on a binary query, without a second generation.
    writeFileSync(script,(windows?'\ufeff':'')+blocks[0]+'\n'+setup+request);
    const args=windows?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script]:[script];
    const r=await new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:work,env:{...env,OPENCODE_CONFIG:config,TMPDIR:work,TEMP:work,TMP:work}});let stdout='',stderr='';
      child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));
    });
    check(platform+': native wrapper preserves Unicode/quoting and saves JSON fallback',()=>{
      assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim().split(/\r?\n/).length,2);
      const last=requests.at(-1);assert.equal(last.auth,'Bearer test-gateway-key');assert.deepEqual(last.body,{model:'test/image',prompt,n:1});assert.equal(last.url,'/v1/images/generations?response_format=binary');
    });

    gatewayStatus=503;
    const beforeRequests=requests.length;
    const failed=await new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:work,env:{...env,OPENCODE_CONFIG:config,TMPDIR:work,TEMP:work,TMP:work}});let stdout='',stderr='';
      child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));
    });
    check(platform+': native HTTP failure preserves diagnostics, removes prompt and does not retry',()=>{
      assert.notEqual(failed.status,0);assert.equal(requests.length,beforeRequests+1);assert.equal(failed.stdout,'');assert.match(failed.stderr,/503/);
      const dirs=readdirSync(work).filter(n=>n.startsWith('9router-image-'));
      assert.ok(dirs.length);
      for(const dir of dirs){const base=path.join(work,dir);assert.equal(existsSync(path.join(base,'body.json')),false);assert.ok(readFileSync(path.join(base,'response.bin'),'utf8').includes('synthetic unavailable'));assert.match(readFileSync(path.join(base,'headers.txt'),'utf8'),/retry-after: 120/i);}
    });
    gatewayStatus=200;

  }

  console.log(checks+' checks passed; no build or live image generation.');
} finally {
  if(nativeServer) await new Promise(resolve=>nativeServer.close(resolve));
  if(server) await new Promise(resolve=>server.close(resolve));
  assert.equal(path.dirname(path.resolve(work)),path.resolve(tmpdir()));
  assert.ok(path.basename(work).startsWith('9router-skill-tests-'));
  rmSync(work,{recursive:true,force:true});
}
