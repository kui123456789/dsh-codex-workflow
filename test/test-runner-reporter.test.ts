import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const realCli = require.resolve("tsx/cli");
const launcher = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-test-reporter-"));
  await Promise.all([mkdir(join(directory,"scripts")), mkdir(join(directory,"test")), mkdir(join(directory,"node_modules","tsx"),{recursive:true})]);
  await copyFile(launcher, join(directory,"scripts","run-tests.mjs"));
  await writeFile(join(directory,"package.json"), JSON.stringify({type:"module"}));
  await writeFile(join(directory,"node_modules","tsx","package.json"), JSON.stringify({name:"tsx",type:"module",exports:{"./cli":"./cli.mjs"}}));
  await writeFile(join(directory,"node_modules","tsx","cli.mjs"),
    `import { writeFileSync } from "node:fs"; import { spawnSync } from "node:child_process"; writeFileSync(${JSON.stringify(join(directory,"invocation.json"))}, JSON.stringify(process.argv.slice(2))); const child=spawnSync(process.execPath,[${JSON.stringify(realCli)},...process.argv.slice(2)],{stdio:"inherit",windowsHide:true}); if(child.error) throw child.error; process.exitCode=child.status??1;`);
  await writeFile(join(directory,"test","one.test.ts"), 'import test from "node:test"; test("original passing case",()=>{}); test.skip("original skipped case",()=>{});');
  await writeFile(join(directory,"test","two.test.ts"), 'import test from "node:test"; test.todo("original todo case");');
  return {directory,async close() { assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)); await rm(directory,{recursive:true,force:true}); }};
}

async function run(directory:string, reporter:string|undefined, flags:string[]=[], concurrency="1") {
  const env: NodeJS.ProcessEnv = {...process.env, DSH_WORKFLOW_TEST_CONCURRENCY:concurrency};
  // This fixture starts an independent runner, not a child reporting back to
  // this test file through Node's internal test serialization channel.
  delete env.NODE_TEST_CONTEXT;
  if (reporter === undefined) delete env.DSH_WORKFLOW_TEST_REPORTER; else env.DSH_WORKFLOW_TEST_REPORTER = reporter;
  const child = spawn(process.execPath,[join(directory,"scripts","run-tests.mjs"),...flags],{cwd:directory,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data",chunk=>{stdout+=chunk;}); child.stderr.on("data",chunk=>{stderr+=chunk;});
  const code = await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  const invocation = await readFile(join(directory,"invocation.json"),"utf8").then(text=>JSON.parse(text) as string[],error=>{
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
  });
  return {code,stdout,stderr,invocation};
}

test("test runner environment selects TAP with ASCII counts without dropping skip or todo",async()=>{
  const f=await fixture(); try {
    const result=await run(f.directory,"tap");
    assert.equal(result.code,0); assert.match(result.stdout,/TAP version 13/);
    for (const [name,value] of Object.entries({tests:3,pass:1,fail:0,cancelled:0,skipped:1,todo:1})) assert.match(result.stdout,new RegExp(`^# ${name} ${value}$`,"m"));
    assert.deepEqual(result.invocation,["--test","--test-concurrency=1","--test-reporter=tap","test/one.test.ts","test/two.test.ts"]);
  } finally {await f.close();}
});

for (const reporter of [undefined,"","spec"]) test(`test runner preserves normal output when reporter is ${String(reporter)}`,async()=>{
  const f=await fixture(); try {
    const result=await run(f.directory,reporter); assert.equal(result.code,0); assert.match(result.stdout,/original passing case/);
    if (reporter === "spec") assert.equal(result.stdout.includes("TAP version 13"),false);
    assert.equal(result.invocation!.filter(flag=>flag.startsWith("--test-reporter=")).length,reporter === "spec" ? 1 : 0);
  } finally {await f.close();}
});

for (const flags of [["--test-reporter=spec"],["--test-reporter","spec"],["--test-reporter=tap"]]) test(`explicit Node reporter takes precedence over the environment: ${flags.join(" ")}`,async()=>{
  const f=await fixture(); try {
    const result=await run(f.directory,"tap",flags); assert.equal(result.code,0);
    assert.deepEqual(result.invocation,["--test","--test-concurrency=1",...flags,"test/one.test.ts","test/two.test.ts"]);
    assert.equal(result.stdout.includes("TAP version 13"),flags[0] === "--test-reporter=tap");
  } finally {await f.close();}
});

for (const reporter of ["json","TAP"," tap "]) test(`invalid environment reporter is rejected before launching tests: ${reporter}`,async()=>{
  const f=await fixture(); try {
    const result=await run(f.directory,reporter); assert.equal(result.code,2); assert.equal(result.invocation,undefined);
    assert.match(result.stderr,/DSH_WORKFLOW_TEST_REPORTER.*spec.*tap/);
  } finally {await f.close();}
});

test("TAP reporting preserves a real failing test exit code",async()=>{
  const f=await fixture(); try {
    await writeFile(join(f.directory,"test","one.test.ts"),'import test from "node:test"; test("original failing case",()=>{throw new Error("original failure");});');
    const result=await run(f.directory,"tap"); assert.equal(result.code,1); assert.match(result.stdout,/original failure/); assert.match(result.stdout,/^# fail 1$/m);
  } finally {await f.close();}
});

test("TAP reporter preserves launcher separator, file concurrency and name filtering",async()=>{
  const f=await fixture(); try {
    const result=await run(f.directory,"tap",["--","--test-name-pattern=original passing case"],"2");
    // The default treatment of filtered/empty files varies between supported
    // Node versions; preserve the real runner's flag and resulting exit code.
    assert.equal(result.code,0); assert.match(result.stdout,/^# tests [0-9]+$/m);
    assert.match(result.stdout,/original passing case/);
    assert.deepEqual(result.invocation,["--test","--test-concurrency=2","--test-reporter=tap","--test-name-pattern=original passing case","test/one.test.ts","test/two.test.ts"]);
  } finally {await f.close();}
});

test("explicit multiple reporters retain their paired destinations",async()=>{
  const f=await fixture(); try {
    const flags=["--test-reporter=spec","--test-reporter=tap","--test-reporter-destination=stdout","--test-reporter-destination=stderr"];
    const result=await run(f.directory,"tap",flags);
    assert.equal(result.code,0); assert.match(result.stdout,/original passing case/); assert.match(result.stderr,/TAP version 13/);
    assert.deepEqual(result.invocation,["--test","--test-concurrency=1",...flags,"test/one.test.ts","test/two.test.ts"]);
  } finally {await f.close();}
});
