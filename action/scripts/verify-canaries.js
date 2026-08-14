const version = requiredEnvironment('GALA_VERSION', /^\d+\.\d+\.\d+$/);

const canaries = [
  {
    repository: 'rathnasgala/smoke01',
    runId: requiredEnvironment('GALA_SMOKE01_RUN_ID', /^\d+$/),
    articleUrl: 'https://rathnasgala.github.io/smoke01/en/example/',
    sitemapUrl: 'https://rathnasgala.github.io/smoke01/sitemap.xml',
    assetBaseUrl: 'https://rathnasgala.github.io/smoke01/'
  },
  {
    repository: 'rathnasgala/smoke02',
    runId: requiredEnvironment('GALA_SMOKE02_RUN_ID', /^\d+$/),
    articleUrl: 'https://smoke.gala67.com/en/example/',
    sitemapUrl: 'https://smoke.gala67.com/sitemap.xml',
    assetBaseUrl: 'https://smoke.gala67.com/'
  }
];

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (value == null || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

async function responseText(url, accept = 'text/html') {
  const response = await fetch(url, {
    headers: { Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function verifyCanary(canary) {
  const run = JSON.parse(await responseText(
    `https://api.github.com/repos/${canary.repository}/actions/runs/${canary.runId}`,
    'application/vnd.github+json'
  ));
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`${canary.repository} run ${canary.runId} is not a completed success`);
  }
  if (run.event !== 'workflow_dispatch') {
    throw new Error(`${canary.repository} run ${canary.runId} was not manually dispatched`);
  }

  const workflowFile = JSON.parse(await responseText(
    `https://api.github.com/repos/${canary.repository}/contents/.github/workflows/publish.yml?ref=${run.head_sha}`,
    'application/vnd.github+json'
  ));
  const workflow = Buffer.from(workflowFile.content, 'base64').toString('utf8');
  const expectedReference = `rathnasgala/publish/.github/workflows/publish.yml@v${version}`;
  if (!workflow.includes(expectedReference)) {
    throw new Error(`${canary.repository} run ${canary.runId} did not execute ${expectedReference}`);
  }

  const article = await responseText(canary.articleUrl);
  const canonical = `<link rel="canonical" href="${canary.articleUrl}">`;
  if (!article.includes(canonical)) {
    throw new Error(`${canary.repository} canonical URL does not equal ${canary.articleUrl}`);
  }
  for (const suffix of ['assets/theme.css', 'assets/interactions.js']) {
    await responseText(new URL(suffix, canary.assetBaseUrl).href, '*/*');
  }
  const articleId = article.match(/data-article-id="([0-7][0-9A-HJKMNP-TV-Z]{25})"/)?.[1];
  if (articleId == null) throw new Error(`${canary.repository} article has no canonical ULID widget identity`);
  const engagement = JSON.parse(await responseText(
    `https://api.gala67.com/v1/articles/${articleId}/engagement`,
    'application/json'
  ));
  if (engagement.data == null || !Array.isArray(engagement.errors)) {
    throw new Error(`${canary.repository} engagement endpoint violated its response envelope`);
  }

  const sitemap = await responseText(canary.sitemapUrl, 'application/xml');
  if (!sitemap.includes(`<loc>${canary.articleUrl}</loc>`)
      || !sitemap.includes(`hreflang="en" href="${canary.articleUrl}"`)
      || !sitemap.includes(`hreflang="x-default" href="${canary.articleUrl}"`)) {
    throw new Error(`${canary.repository} sitemap does not exactly recompose the canonical topology`);
  }
}

for (const canary of canaries) await verifyCanary(canary);
