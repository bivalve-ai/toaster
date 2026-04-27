#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, writeFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.A2E_TIMEOUT_MS ?? 90 * 1000);
const heartbeatMs = Number(process.env.A2E_HEARTBEAT_MS ?? 2 * 1000);
const strict = process.env.A2E_STRICT === "1";

const provider = process.env.A2E_PROVIDER ?? "openai-codex";
const model = process.env.A2E_MODEL ?? "gpt-5.4-mini";
const agentCommand = process.env.A2E_AGENT_CMD ?? "pi";
const tools = process.env.A2E_TOOLS ?? "read,bash";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      options.stdout?.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      options.stderr?.write(chunk);
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function commandExists(command) {
  const result = await run("bash", ["-lc", `command -v ${JSON.stringify(command)}`]);
  return result.code === 0;
}

async function findFiles(root, name, acc = []) {
  if (!existsSync(root)) return acc;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await findFiles(path, name, acc);
    } else if (entry.name === name) {
      acc.push(path);
    }
  }
  return acc;
}

function isEnvironmentFailure(text) {
  return /No API key found|out of extra usage|quota|rate.?limit|authentication|unauthorized|provider.*key|model.*not.*found/i.test(
    text,
  );
}

async function writeRunReport(path, report) {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

function writeRunReportSync(path, report) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function finish(status, message, report, exitCode) {
  console.log(`A2E ${status}: ${message}`);
  console.log(`Temp dir: ${report.workdir}`);
  process.exit(exitCode);
}

const workdir = await mkdtemp(join(tmpdir(), "toaster-a2e-"));
const reportPath = join(workdir, "A2E_RUN.json");
const report = {
  status: "initializing",
  workdir,
  agentCommand,
  provider,
  model,
  tools,
  timeoutMs,
  heartbeatMs,
  strict,
  startedAt: new Date().toISOString(),
  artifacts: {},
  checks: {},
};

function handleAbort(signal) {
  report.status = "aborted";
  report.reason = `received ${signal}`;
  report.finishedAt = new Date().toISOString();
  try {
    writeRunReportSync(reportPath, report);
  } catch {
    // Best effort only. The process is already exiting.
  }
  console.error(`A2E aborted: received ${signal}`);
  console.error(`Temp dir: ${workdir}`);
  process.exit(130);
}

process.once("SIGINT", handleAbort);
process.once("SIGTERM", handleAbort);

try {
  await mkdir(join(workdir, "artifacts"), { recursive: true });
  await writeRunReport(reportPath, report);

  if (!(await commandExists(agentCommand))) {
    report.status = "skipped";
    report.reason = `${agentCommand} command not found`;
    await writeRunReport(reportPath, report);
    finish("skipped", report.reason, report, strict ? 1 : 0);
  }

  report.status = "packing";
  await writeRunReport(reportPath, report);
  console.log("Packing Toaster...");
  const pack = await run("npm", ["pack", "--silent", "--pack-destination", workdir], {
    cwd: repoRoot,
  });
  if (pack.code !== 0) {
    report.status = "failed";
    report.reason = "npm pack failed";
    report.pack = { stdout: pack.stdout, stderr: pack.stderr };
    await writeRunReport(reportPath, report);
    finish("failed", report.reason, report, 1);
  }

  const packed = (await readdir(workdir)).find((file) => file.endsWith(".tgz"));
  if (!packed) {
    report.status = "failed";
    report.reason = "npm pack did not produce a .tgz";
    await writeRunReport(reportPath, report);
    finish("failed", report.reason, report, 1);
  }
  const tarball = join(workdir, packed);
  report.artifacts.tarball = tarball;

  await writeFile(join(workdir, "package.json"), '{"private":true,"type":"module"}\n');
  report.status = "installing";
  await writeRunReport(reportPath, report);
  console.log("Installing packed Toaster into temp project...");
  const install = await run(
    "npm",
    ["install", "--silent", "--no-audit", "--no-fund", tarball],
    { cwd: workdir },
  );
  if (install.code !== 0) {
    report.status = "failed";
    report.reason = "npm install of packed Toaster failed";
    report.install = { stdout: install.stdout, stderr: install.stderr };
    await writeRunReport(reportPath, report);
    finish("failed", report.reason, report, 1);
  }

  await copyFile(join(repoRoot, "README.md"), join(workdir, "README.md"));
  await copyFile(
    join(repoRoot, "a2e", "scenarios", "core-flow.md"),
    join(workdir, "SCENARIO.md"),
  );

  const toasterBin = join(workdir, "node_modules", ".bin", "toaster");
  report.status = "preflight";
  await writeRunReport(reportPath, report);
  const preflight = await run(toasterBin, ["scan", "--limit", "1"], { cwd: workdir });
  report.preflightScan = {
    code: preflight.code,
    stdout: preflight.stdout,
    stderr: preflight.stderr,
  };

  if (preflight.code !== 0) {
    report.status = "skipped";
    report.reason = "toaster scan preflight failed";
    await writeRunReport(reportPath, report);
    finish("skipped", report.reason, report, strict ? 1 : 0);
  }

  try {
    const parsed = JSON.parse(preflight.stdout);
    if (!parsed.total) {
      report.status = "skipped";
      report.reason = "no native agent sessions found for cleanroom flow";
      await writeRunReport(reportPath, report);
      finish("skipped", report.reason, report, strict ? 1 : 0);
    }
  } catch {
    report.status = "failed";
    report.reason = "toaster scan preflight did not print JSON";
    await writeRunReport(reportPath, report);
    finish("failed", report.reason, report, 1);
  }

  const prompt = `You are running Toaster's A2E cleanroom test.\n\nYou are a fresh agent. Use only files in this temp project, public README/docs copied here, Toaster CLI help, and command output. Do not inspect the Toaster source repository, old transcripts, private notes, or hidden maintainer context.\n\nWorking directory: ${workdir}\nToaster binary: ./node_modules/.bin/toaster\n\nRead SCENARIO.md first. Use README.md and toaster --help only if you are unsure. Execute the workflow directly; do not spend time summarizing docs. Use small limits. Do not pass --launch.\n\nAt the end, write ./A2E_REPORT.md exactly as requested in SCENARIO.md.\n`;
  const promptPath = join(workdir, "FRESH_AGENT_PROMPT.md");
  await writeFile(promptPath, prompt);

  const stdoutPath = join(workdir, "stdout.txt");
  const stderrPath = join(workdir, "stderr.txt");
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  report.artifacts.stdout = stdoutPath;
  report.artifacts.stderr = stderrPath;
  report.artifacts.prompt = promptPath;

  report.status = "running-agent";
  await writeRunReport(reportPath, report);
  console.log("Starting fresh-agent cleanroom run...");
  console.log(`Provider/model: ${provider}/${model}`);
  console.log(`Timeout: ${Math.round(timeoutMs / 1000)}s; heartbeat: ${Math.round(heartbeatMs / 1000)}s`);
  console.log(`Temp dir: ${workdir}`);
  console.log("Pi runs in JSON mode so tool/model events stream while the agent works.");
  const child = spawn(
    agentCommand,
    [
      "--provider",
      provider,
      "--model",
      model,
      "--no-context-files",
      "--no-skills",
      "--tools",
      tools,
      "--mode",
      "json",
      "-p",
      `@${promptPath}`,
    ],
    { cwd: workdir, env: process.env, shell: false },
  );

  let agentStdout = "";
  let agentStderr = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdout.write(chunk);
    agentStdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderr.write(chunk);
    agentStderr += chunk.toString();
  });

  const started = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    const remainingSeconds = Math.max(0, Math.round((timeoutMs - (Date.now() - started)) / 1000));
    console.log(
      `[a2e] fresh agent still running: elapsed=${elapsedSeconds}s remaining=${remainingSeconds}s stdout=${Buffer.byteLength(agentStdout)}B stderr=${Buffer.byteLength(agentStderr)}B temp=${workdir}`,
    );
  }, heartbeatMs);

  const agentResult = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[a2e] timeout after ${Math.round(timeoutMs / 1000)}s; terminating fresh agent`);
      child.kill("SIGTERM");
      resolve({ code: 124, timedOut: true });
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      resolve({ code: code ?? 1, signal, timedOut: false });
    });
  });
  stdout.end();
  stderr.end();

  report.agent = {
    code: agentResult.code,
    signal: agentResult.signal,
    timedOut: agentResult.timedOut,
  };

  if (agentResult.code !== 0) {
    const combined = `${agentStdout}\n${agentStderr}`;
    report.status = isEnvironmentFailure(combined) ? "skipped" : "failed";
    report.reason = agentResult.timedOut
      ? `fresh agent timed out after ${timeoutMs}ms`
      : `fresh agent exited with code ${agentResult.code}`;
    await writeRunReport(reportPath, report);
    finish(report.status, report.reason, report, report.status === "skipped" && !strict ? 0 : 1);
  }

  const toastFiles = await findFiles(join(workdir, "toast-library"), "toast.json");
  const checks = {
    agentReport: existsSync(join(workdir, "A2E_REPORT.md")),
    toastLibrary: existsSync(join(workdir, "toast-library")),
    toastFiles: toastFiles.length,
    safeArtifact: existsSync(join(workdir, "safe.toast.json")),
    mirror: existsSync(join(workdir, "toast-library-cloud")),
  };
  report.checks = checks;

  if (checks.agentReport) {
    const reportText = await readFile(join(workdir, "A2E_REPORT.md"), "utf8");
    report.agentReportBytes = Buffer.byteLength(reportText);
  }
  if (checks.safeArtifact) {
    report.artifacts.safeArtifactBytes = (await stat(join(workdir, "safe.toast.json"))).size;
  }

  const missing = Object.entries(checks)
    .filter(([key, value]) => (key === "toastFiles" ? value < 1 : !value))
    .map(([key]) => key);

  if (missing.length) {
    report.status = "failed";
    report.reason = `fresh agent completed, but expected artifacts are missing: ${missing.join(", ")}`;
    await writeRunReport(reportPath, report);
    finish("failed", report.reason, report, 1);
  }

  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  await writeRunReport(reportPath, report);
  finish("passed", "fresh agent completed the core flow", report, 0);
} catch (error) {
  report.status = "failed";
  report.reason = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  await writeRunReport(reportPath, report);
  finish("failed", report.reason, report, 1);
}
