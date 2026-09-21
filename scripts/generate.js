#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ORG = process.env.ORG;
// Where generated wrapper actions are written, relative to the repo root; set by the calling workflow.
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'actions/3rdparty';
let TOKEN = null;
const GH_APP_ID = process.env.GH_APP_ID;
const GH_APP_PRIVATE_KEY = process.env.GH_APP_PRIVATE_KEY;

if (!ORG) {
  console.error('ORG environment variable is required');
  process.exit(1);
}

if (!GH_APP_ID || !GH_APP_PRIVATE_KEY) {
  console.error('GH_APP_ID and GH_APP_PRIVATE_KEY repository secrets are required (GitHub App auth only)');
  process.exit(1);
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function createJwt(appId, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (9 * 60); // 9 minutes
  const payload = { iat, exp, iss: appId };
  const signingInput = `${base64UrlEncode(Buffer.from(JSON.stringify(header)))}.${base64UrlEncode(Buffer.from(JSON.stringify(payload)))}`;
  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64');
  const signatureUrl = signature.replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${signingInput}.${signatureUrl}`;
}

function getHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'fortify-3rdparty-actions-generator'
  };
  if (TOKEN) h['Authorization'] = `token ${TOKEN}`;
  return h;
}

const api = (url, opts={}) => fetch(url, { headers: getHeaders(), ...opts }).then(async res => {
  if (!res.ok) {
    const txt = await res.text();
    const e = new Error(`HTTP ${res.status} ${res.statusText} for ${url}: ${txt}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
});

async function obtainAppInstallationToken(org) {
  if (!GH_APP_ID || !GH_APP_PRIVATE_KEY) return null;
  try {
    const jwt = createJwt(GH_APP_ID, GH_APP_PRIVATE_KEY);
    // find installation for org
    const installUrl = `https://api.github.com/orgs/${org}/installation`;
    const res = await fetch(installUrl, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`Could not find installation for org ${org}: ${res.status} ${txt}`);
      return null;
    }
    const inst = await res.json();
    const iid = inst.id;
    const tokenUrl = `https://api.github.com/app/installations/${iid}/access_tokens`;
    const tokenRes = await fetch(tokenUrl, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.warn(`Could not create installation token: ${tokenRes.status} ${txt}`);
      return null;
    }
    const tok = await tokenRes.json();
    return tok.token;
  } catch (err) {
    console.warn('Error obtaining app installation token', err.message || err);
    return null;
  }
}

async function fetchAllowedActions(org) {
  const url = `https://api.github.com/orgs/${org}/actions/permissions/selected-actions`;
  try {
    const data = await api(url);
    const patterns = Array.isArray(data.patterns_allowed) ? data.patterns_allowed : [];
    const list = [];
    for (const p of patterns) {
      if (typeof p !== 'string') continue;
      // skip wildcard patterns (we only process explicit owner/repo@ref entries)
      if (p.includes('*')) continue;
      // accept only owner/repo@ref
      const m = p.match(/^([^/]+)\/([^@]+)@(.+)$/);
      if (m) {
        list.push(p);
      } else {
        console.warn(`Skipping invalid allowed-action pattern (not in owner/repo@ref format): ${p}`);
      }
    }
    if (list.length) return list;
    console.warn(`No non-wildcard allowed-actions found in org API response at ${url}`);
  } catch (err) {
    console.warn(`Failed to fetch allowed-actions from ${url}: ${err.message}`);
  }

  // fallback to local file if present
  const local = path.join(process.cwd(), 'allowed-actions.json');
  if (fs.existsSync(local)) {
    const j = JSON.parse(fs.readFileSync(local, 'utf8'));
    if (Array.isArray(j)) return j;
  }
  throw new Error('Could not retrieve allowed actions list from API and no allowed-actions.json found');
}

function parseActionString(s) {
  // owner/repo@ref
  const m = s.match(/^([^/]+)\/([^@]+)@(.+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3], raw: s };
}

function isSha(ref) {
  return /^[0-9a-f]{40}$/i.test(ref);
}

async function resolveRefToSha(owner, repo, ref) {
  // GET /repos/{owner}/{repo}/commits/{ref}
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  try {
    const data = await api(url);
    return data.sha;
  } catch (err) {
    return null;
  }
}

async function getTags(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=100`;
  try {
    return await api(url);
  } catch (err) {
    return [];
  }
}

async function getCommitDate(owner, repo, sha) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`;
  try {
    const data = await api(url);
    return data && data.commit && data.commit.committer && data.commit.committer.date ? data.commit.committer.date : (data && data.commit && data.commit.author && data.commit.author.date ? data.commit.author.date : null);
  } catch (err) {
    return null;
  }
}

function semverCompare(a,b){
  const pa = a.split('.').map(x=>parseInt(x)||0);
  const pb = b.split('.').map(x=>parseInt(x)||0);
  for(let i=0;i<3;i++){if(pa[i]>pb[i])return 1;if(pa[i]<pb[i])return-1}return 0;
}

function extractMajorFromTag(tag) {
  // tag like v1.2.3 or 1.2.3
  const m = tag.match(/v?(\d+)(?:[.-]|$)/);
  if (m) return parseInt(m[1],10);
  return null;
}

async function fetchActionYaml(owner, repo, ref) {
  // Try action.yml then action.yaml
  const candidates = ['action.yml','action.yaml', '.github/action.yml', '.github/action.yaml'];
  for (const p of candidates) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${p}?ref=${encodeURIComponent(ref)}`;
    try {
      const data = await api(url);
      if (data && data.content) {
        const buf = Buffer.from(data.content, 'base64').toString('utf8');
        return { path: p, content: buf };
      }
    } catch (err) {
      // continue
    }
  }
  return null;
}

async function main(){
  console.log('Reading allowed actions for org', ORG);
  console.log('Writing generated wrapper actions under', OUTPUT_DIR);
  // Load optional outputs.json that can declare outputs for generated wrappers.
  let declaredOutputs = {};
  try {
    const outputsPath = path.join(process.cwd(),'outputs.json');
    if (fs.existsSync(outputsPath)) {
      declaredOutputs = JSON.parse(fs.readFileSync(outputsPath,'utf8') || '{}');
      console.log('Loaded outputs.json with', Object.keys(declaredOutputs).length, 'entries');
    }
  } catch (e) {
    console.warn('Failed to read outputs.json:', e.message || e);
  }
  // Prefer GitHub App authentication when configured
  // Obtain installation token via GitHub App; this script requires the App to be installed on the org
  const tok = await obtainAppInstallationToken(ORG);
  if (!tok) {
    console.error('Failed to obtain installation token for the GitHub App; ensure the App is installed on the organization and secrets are set');
    process.exit(1);
  }
  TOKEN = tok;
  console.log('Using GitHub App installation token for API calls');

  const list = await fetchAllowedActions(ORG);
  const parsed = list.map(parseActionString).filter(Boolean);
  const filtered = parsed.filter(p => !p.ref.includes('*'));

  const byName = {};
  const warnings = [];

  for (const item of filtered) {
    const key = `${item.owner}/${item.repo}`;
    if (!byName[key]) byName[key]=[];
    byName[key].push(item);
  }

  for (const key of Object.keys(byName)) {
    const items = byName[key];
    // resolve refs to shas where possible and collect tag info
    const owner = items[0].owner;
    const repo = items[0].repo;
    const tags = await getTags(owner, repo);

    for (const it of items) {
      if (!isSha(it.ref)){
        // warn and resolve
        const sha = await resolveRefToSha(it.owner, it.repo, it.ref);
        warnings.push(`Ref ${it.raw} is not a SHA; resolved to ${sha || '<unresolved>'}`);
        it.resolvedSha = sha;
        // try to find a tag name for this sha
        const foundTag = tags.find(t => t.commit && t.commit.sha && sha && t.commit.sha.startsWith(sha));
        if (foundTag) it.resolvedTag = foundTag.name;
      } else {
        it.resolvedSha = it.ref;
        const foundTag = tags.find(t => t.commit && t.commit.sha && it.resolvedSha && t.commit.sha.startsWith(it.resolvedSha));
        if (foundTag) it.resolvedTag = foundTag.name;
      }
      // derive major
      if (it.resolvedTag) {
        const maj = extractMajorFromTag(it.resolvedTag);
        it.major = maj===null?0:maj;
      } else if (it.ref && it.ref.startsWith('v')) {
        const maj = extractMajorFromTag(it.ref);
        it.major = maj===null?0:maj;
      } else if (isSha(it.ref)) {
        it.major = 0; // unknown
      } else {
        it.major = 0;
      }
    }

    // choose latest per major
    const byMajor = {};
    for (const it of items) {
      const m = it.major||0;
      if (!byMajor[m]) byMajor[m]=[];
      byMajor[m].push(it);
    }

    for (const maj of Object.keys(byMajor)){
      const arr = byMajor[maj];
      // if tags present, pick highest semver tag
      let chosen = arr[0];
      if (arr.length>1){
        // Prefer explicit SHA entries if any were listed in the allowlist
        const withOriginalSha = arr.filter(a => isSha(a.ref));
        if (withOriginalSha.length > 0) {
          // pick latest by commit date when multiple SHAs
          if (withOriginalSha.length > 1) {
            const dated = [];
            for (const w of withOriginalSha) {
              const d = await getCommitDate(owner, repo, w.ref);
              dated.push({ item: w, date: d });
            }
            dated.sort((x,y)=>{
              if (!x.date && !y.date) return 0;
              if (!x.date) return 1;
              if (!y.date) return -1;
              return new Date(y.date) - new Date(x.date);
            });
            chosen = dated[0].item;
          } else {
            chosen = withOriginalSha[0];
          }
        } else {
          // No explicit SHA entries; prefer highest semver tag when available
          const withTag = arr.filter(a=>a.resolvedTag);
          if (withTag.length>0){
            withTag.sort((a,b)=>{
              const ta = a.resolvedTag.replace(/^v/,'').split(/[-+]/)[0];
              const tb = b.resolvedTag.replace(/^v/,'').split(/[-+]/)[0];
              return semverCompare(tb,ta); // descending
            });
            chosen = withTag[0];
          } else {
            // fallback: if multiple explicit resolved SHAs (from resolving tags), pick latest by date
            const withResolvedSha = arr.filter(a=>a.resolvedSha);
            if (withResolvedSha.length > 1) {
              const dated = [];
              for (const w of withResolvedSha) {
                const d = await getCommitDate(owner, repo, w.resolvedSha);
                dated.push({ item: w, date: d });
              }
              dated.sort((x,y)=>{
                if (!x.date && !y.date) return 0;
                if (!x.date) return 1;
                if (!y.date) return -1;
                return new Date(y.date) - new Date(x.date);
              });
              chosen = dated[0].item;
            } else {
              chosen = withResolvedSha[0] || arr[0];
            }
          }
        }
      }

      // fetch action.yml from chosen ref (prefer resolvedSha)
      const refToFetch = chosen.resolvedSha || chosen.ref;
      const actionYaml = await fetchActionYaml(owner, repo, refToFetch);
      let inputs = {};
      let outputs = {};
      if (actionYaml) {
        try {
          const doc = yaml.load(actionYaml.content);
          if (doc && doc.inputs) inputs = doc.inputs;
          if (doc && doc.outputs) outputs = doc.outputs;
        } catch (e) {
          warnings.push(`Failed to parse action yaml for ${owner}/${repo}@${refToFetch}: ${e.message}`);
        }
      } else {
        warnings.push(`Could not fetch action.yml for ${owner}/${repo}@${refToFetch}`);
      }

      // Build composite action structure; name by full owner/repo (e.g., actions/3rdparty/googleapis/release-please-action/v4)
      const actionDir = path.join(process.cwd(), OUTPUT_DIR, owner, repo, `v${maj}`);
      fs.mkdirSync(actionDir, { recursive: true });
      const actionYamlOut = {
        name: `${owner}/${repo} (wrapped) v${maj}`,
        description: `Composite wrapper for ${owner}/${repo} pinned to ${chosen.resolvedSha || chosen.ref}`,
        inputs: {},
        outputs: {}
      };

      // mirror inputs (excluding deprecated inputs, as passing them always triggers a deprecation
      // warning in GitHub Actions, even when passed with an empty value from a wrapper action)
      for (const [k,v] of Object.entries(inputs||{})){
        if (v && v.deprecationMessage) continue;
        const entry = { description: v.description || '', required: v.required || false };
        if (v && Object.prototype.hasOwnProperty.call(v, 'default')) {
          entry.default = v.default;
        }
        actionYamlOut.inputs[k] = entry;
      }
      // Use a consistent step id for the upstream action so we can map outputs
      const stepId = 'upstream';
      // First prefer declared outputs from outputs.json (key: owner/repo@v<major>)
      const outputsKey = `${owner}/${repo}@v${maj}`;
      if (declaredOutputs && declaredOutputs[outputsKey]) {
        const decl = declaredOutputs[outputsKey];
        // support either array of names or object map name->description
        if (Array.isArray(decl)) {
          for (const name of decl) {
            actionYamlOut.outputs[name] = { description: '', value: '${{ steps.' + stepId + '.outputs.' + name + ' }}' };
          }
        } else if (typeof decl === 'object' && decl !== null) {
          for (const [name,desc] of Object.entries(decl)) {
            actionYamlOut.outputs[name] = { description: desc || '', value: '${{ steps.' + stepId + '.outputs.' + name + ' }}' };
          }
        }
      } else {
        for (const [k,v] of Object.entries(outputs||{})){
          actionYamlOut.outputs[k] = { description: v.description || '', value: '${{ steps.' + stepId + '.outputs.' + k + ' }}' };
        }
      }

      // Also expose all outputs produced by the upstream step as a single JSON value.
      // This helps when the upstream action does not declare outputs statically.
      if (!actionYamlOut.outputs.all_upstream_outputs) {
        actionYamlOut.outputs.all_upstream_outputs = {
          description: 'All outputs from upstream step as JSON',
          value: '${{ toJSON(steps.' + stepId + '.outputs) }}'
        };
      }

      // steps: single uses pointing to upstream sha/ref
      // Use the original allowed ref in the composite. If the allowed entry used a branch/tag (not a SHA),
      // keep that ref so the composite doesn't reference a SHA that isn't yet allowed by org settings.
      const usesRef = `${owner}/${repo}@${chosen.ref}`;
      const steps = [];
      const step = { id: stepId, uses: usesRef };
      if (Object.keys(actionYamlOut.inputs).length) {
        step.with = {};
        for (const k of Object.keys(actionYamlOut.inputs)){
          // Use the literal expression that GitHub Actions expects
          step.with[k] = '${{ inputs.' + k + ' }}';
        }
      }

      steps.push(step);

      const finalYaml = {
        ...actionYamlOut,
        runs: { using: 'composite', steps }
      };

      const outPath = path.join(actionDir,'action.yml');
      fs.writeFileSync(outPath, yaml.dump(finalYaml), 'utf8');
      console.log('Wrote', outPath);
    }
  }

  // Write warnings
  if (warnings.length) {
    const wpath = path.join(process.cwd(),'WARNINGS.md');
    fs.writeFileSync(wpath, warnings.map(x=>`- ${x}`).join('\n')+'\n','utf8');
    console.log('Warnings written to', wpath);
    // Emit workflow annotations so warnings appear in the workflow run UI
    for (const w of warnings) {
      // GitHub Actions workflow command to create a warning annotation
      console.log(`::warning::${w}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
