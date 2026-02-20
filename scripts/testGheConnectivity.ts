#!/usr/bin/env node
/**
 * Test GHE HTTPS connectivity from Heroku.
 *
 * Usage:
 *   heroku run npm run test-ghe -a pr-manager
 *   heroku run "TEST_PR_URL=https://git.soma.salesforce.com/.../pull/681 npm run test-ghe" -a pr-manager
 */

import 'dotenv/config';
import dns from 'dns';
import https from 'https';
import { getTokenForHost } from '../src/utils/gheTokenResolver';

const HOSTNAMES = ['git.soma.salesforce.com', 'gitcore.soma.salesforce.com'];

function pass(label: string, detail?: string): void {
  console.log(`  [PASS] ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  console.log(`  [FAIL] ${label} — ${detail}`);
}

async function testDNS(hostname: string): Promise<boolean> {
  return new Promise(resolve => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) {
        fail(`DNS resolve ${hostname}`, `${err.code}: ${err.message}`);
        resolve(false);
      } else {
        pass(`DNS resolve ${hostname}`, addresses.join(', '));
        resolve(true);
      }
    });
  });
}

async function testHTTPS(hostname: string): Promise<boolean> {
  const url = `https://${hostname}/api/v3`;
  return new Promise(resolve => {
    const req = https.get(url, { timeout: 10000 }, res => {
      pass(`HTTPS ${url}`, `status ${res.statusCode}`);
      res.resume();
      resolve(true);
    });
    req.on('error', (err: any) => {
      fail(`HTTPS ${url}`, err.message);
      resolve(false);
    });
    req.on('timeout', () => {
      fail(`HTTPS ${url}`, 'timed out after 10s');
      req.destroy();
      resolve(false);
    });
  });
}

async function testAuthenticatedAPI(hostname: string): Promise<boolean> {
  const token = getTokenForHost(hostname);
  if (!token) {
    fail(`Auth API ${hostname}`, 'no token configured');
    return false;
  }

  const url = `https://${hostname}/api/v3/user`;
  return new Promise(resolve => {
    const req = https.get(
      url,
      {
        timeout: 10000,
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'pr-manager-connectivity-test',
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const user = JSON.parse(body);
              pass(`Auth API ${hostname}`, `authenticated as ${user.login}`);
            } catch {
              pass(`Auth API ${hostname}`, `status 200`);
            }
            resolve(true);
          } else {
            fail(`Auth API ${hostname}`, `status ${res.statusCode}`);
            resolve(false);
          }
        });
      },
    );
    req.on('error', (err: any) => {
      fail(`Auth API ${hostname}`, err.message);
      resolve(false);
    });
    req.on('timeout', () => {
      fail(`Auth API ${hostname}`, 'timed out after 10s');
      req.destroy();
      resolve(false);
    });
  });
}

async function testPRFetch(prUrl: string): Promise<boolean> {
  const match = prUrl.match(
    /https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (!match) {
    fail('PR fetch', `could not parse URL: ${prUrl}`);
    return false;
  }

  const [, hostname, org, repo, prNumber] = match;
  const token = getTokenForHost(hostname);
  if (!token) {
    fail('PR fetch', `no token for ${hostname}`);
    return false;
  }

  const apiUrl = `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`;
  return new Promise(resolve => {
    const req = https.get(
      apiUrl,
      {
        timeout: 10000,
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'pr-manager-connectivity-test',
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const pr = JSON.parse(body);
              pass(
                'PR fetch',
                `#${pr.number} "${pr.title}" — state: ${pr.state}, merged: ${pr.merged}`,
              );
            } catch {
              pass('PR fetch', `status 200`);
            }
            resolve(true);
          } else {
            fail('PR fetch', `status ${res.statusCode} for ${apiUrl}`);
            resolve(false);
          }
        });
      },
    );
    req.on('error', (err: any) => {
      fail('PR fetch', err.message);
      resolve(false);
    });
    req.on('timeout', () => {
      fail('PR fetch', 'timed out after 10s');
      req.destroy();
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  console.log('=== GHE HTTPS Connectivity Test ===\n');

  let allPassed = true;

  for (const hostname of HOSTNAMES) {
    console.log(`\n--- ${hostname} ---`);

    const dnsOk = await testDNS(hostname);
    if (!dnsOk) {
      allPassed = false;
      console.log(`  Skipping further tests for ${hostname} (DNS failed)\n`);
      continue;
    }

    const httpsOk = await testHTTPS(hostname);
    if (!httpsOk) allPassed = false;

    const authOk = await testAuthenticatedAPI(hostname);
    if (!authOk) allPassed = false;
  }

  const testPrUrl = process.env.TEST_PR_URL;
  if (testPrUrl) {
    console.log(`\n--- PR fetch test ---`);
    const prOk = await testPRFetch(testPrUrl);
    if (!prOk) allPassed = false;
  }

  console.log('\n=== Summary ===');
  if (allPassed) {
    console.log('All tests passed. Heroku CAN reach GHE over HTTPS.');
    console.log('The local worker could potentially be replaced.');
  } else {
    console.log('Some tests failed. Heroku CANNOT fully reach GHE.');
    console.log('The local worker is still required.');
  }

  process.exit(allPassed ? 0 : 1);
}

main();
