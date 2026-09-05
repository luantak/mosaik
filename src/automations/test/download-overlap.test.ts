import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeComposedAutomation } from "../sandbox.js";

test("bounded downloads overlap sequential actions, retain failures and finish before return", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "mosaik-overlap-"));
  let active = 0,
    peak = 0,
    overlapped = false;
  const opened: number[] = [];
  try {
    const result = await executeComposedAutomation(
      {
        id: "download",
        siteId: "example.com",
        version: 1,
        source: `
      export default defineAutomation(async(ctx)=>{
        const pending=[], results=[];
        for(let i=0;i<12;i++){
          if(pending.length>=4) await pending.shift();
          await ctx.actions.open({i});
          pending.push(ctx.files.download({url:"https://example.com/"+i,path:i+".jpg"}).then(
            file=>{results[i]={file};}, error=>{results[i]={error:String(error)};}
          ));
        }
        await Promise.all(pending);
        await ctx.files.write("result.json",results);
        return results;
      });`,
      },
      {
        outputDirectory,
        actionNames: ["open"],
        host: {
          invoke: async (_name, args) => {
            opened.push((args as { i: number }).i);
            if (active > 0) overlapped = true;
            return {};
          },
        },
        readCapturedResponse: async (url) => {
          active++;
          peak = Math.max(peak, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (url.endsWith("/5")) throw new Error("Missing file");
            return { url, contentType: "image/jpeg", bytes: Buffer.from(url) };
          } finally {
            active--;
          }
        },
      },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(overlapped, true);
    assert.ok(peak > 1 && peak <= 4, "bounded concurrent transfers");
    assert.equal(active, 0);
    assert.deepEqual(
      opened,
      Array.from({ length: 12 }, (_, i) => i),
    );
    assert.equal(result.files?.length, 12); // Eleven images and the manifest.
    const values = result.value as Array<{ error?: string; file?: { relativePath: string } }>;
    assert.match(values[5]!.error!, /Missing file/);
    assert.equal(values[11]!.file?.relativePath, "11.jpg");
    assert.deepEqual(
      JSON.parse(await readFile(join(outputDirectory, "result.json"), "utf8")),
      values,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("runtime caps eager transfers and drains them when the handler returns early", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "mosaik-drain-"));
  let active = 0,
    peak = 0;
  try {
    const result = await executeComposedAutomation(
      {
        id: "drain",
        siteId: "example.com",
        version: 1,
        source: `
      export default defineAutomation(async(ctx)=>{
        for(let i=0;i<9;i++) ctx.files.download({url:"https://example.com/"+i,path:"cover.jpg"});
        return "queued";
      });`,
      },
      {
        outputDirectory,
        host: { invoke: async () => ({}) },
        readCapturedResponse: async (url) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return { url, contentType: "image/jpeg", bytes: Buffer.from(url) };
        },
      },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(active, 0);
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(result.files?.length, 9);
    assert.equal(new Set(result.files?.map((file) => file.relativePath)).size, 9);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("concurrent transfers cannot exceed the output file limit", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "mosaik-file-limit-"));
  try {
    const result = await executeComposedAutomation(
      {
        id: "limit",
        siteId: "example.com",
        version: 1,
        source: `
      export default defineAutomation(async(ctx)=>{
        const jobs=[];
        for(let i=0;i<130;i++) jobs.push(ctx.files.download({url:"https://example.com/"+i,path:i+".jpg"}).then(()=>true,()=>false));
        return await Promise.all(jobs);
      });`,
      },
      {
        outputDirectory,
        host: { invoke: async () => ({}) },
        readCapturedResponse: async (url) => {
          await new Promise((resolve) => setTimeout(resolve, 3));
          return { url, contentType: "image/jpeg", bytes: Buffer.from(url) };
        },
      },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.files?.length, 128);
    assert.equal((result.value as boolean[]).filter((x) => !x).length, 2);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("cancellation prevents late response bodies from writing output", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "mosaik-cancel-download-"));
  const controller = new AbortController();
  let writes = 0;
  try {
    const result = await executeComposedAutomation(
      {
        id: "cancel",
        siteId: "example.com",
        version: 1,
        source:
          'export default defineAutomation(async(ctx)=>await ctx.files.download({url:"https://example.com/image",path:"image.jpg"}));',
      },
      {
        outputDirectory,
        signal: controller.signal,
        host: { invoke: async () => ({}) },
        onFileWrite: () => {
          writes++;
        },
        readCapturedResponse: async (url) => {
          controller.abort("Cancelled");
          return { url, contentType: "image/jpeg", bytes: Buffer.from("late") };
        },
      },
    );
    assert.equal(result.success, false);
    assert.equal(writes, 0);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
