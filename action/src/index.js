import * as core from '@actions/core';
import { parseActionInputs, publicOutputs } from './contract.js';
import { CONTENT_VALIDATION_VERSION } from './envelope.js';
import { createHostedAdapters } from './hosted.js';
import { runAction } from './orchestrator.js';

export async function runEntrypoint({
  getInput = core.getInput,
  setOutput = core.setOutput,
  setSecret = core.setSecret,
  env = process.env,
  root = process.cwd(),
  adapters = createHostedAdapters({ env }),
  run = runAction
} = {}) {
  const input = parseActionInputs({ getInput, env, root });
  setSecret(input.siteSecret);
  const result = await run(input, adapters);
  for (const [name, value] of Object.entries(publicOutputs(result, CONTENT_VALIDATION_VERSION))) {
    setOutput(name, value);
  }
  return result;
}

if (process.env.GITHUB_ACTIONS === 'true') {
  runEntrypoint().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)));
}
