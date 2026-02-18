#!/usr/bin/env npx ts-node
/**
 * GCP Shard Setup Script
 *
 * Interactive, idempotent script to set up GCP Secret Manager infrastructure
 * for Shamir key sharding. Reads the shard manifest to determine which secrets
 * need to be created, then sets up service accounts and Workload Identity
 * Federation for AWS cross-cloud authentication.
 *
 * Usage:
 *   npx ts-node scripts/gcp-shard-setup.ts --manifest path/to/manifest.json
 *
 * Requirements:
 *   - gcloud CLI installed and authenticated
 *   - Appropriate GCP permissions (Project Owner or equivalent)
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ============================================================================
// Console UI Helpers (defined early for HELP_TEXT)
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// ============================================================================
// Help Text
// ============================================================================

const HELP_TEXT = `
${colors.bold}GCP Shard Setup${colors.reset}

Interactive, idempotent script to set up GCP Secret Manager infrastructure
for Shamir key sharding. Reads secrets to create from a manifest file.

${colors.bold}USAGE:${colors.reset}
  npx ts-node scripts/gcp-shard-setup.ts [OPTIONS]

${colors.bold}OPTIONS:${colors.reset}
  --manifest, -m <path>   Path to shard manifest JSON file (required)
  --force                 Force update of Workload Identity config (for AWS role changes)
  --help, -h              Show this help message

${colors.bold}KEY ROTATION:${colors.reset}
  This script sets up infrastructure (secrets, service accounts, workload identity).
  For key rotation, you don't re-run this script - instead:

  1. Generate new shares:
     yarn shamir:split --secret "NEW_SECRET" --gcp-project PROJECT --gcp-secret SECRET_ID

  2. Or manually add a new secret version:
     echo -n "NEW_SHARE2" | gcloud secrets versions add SECRET_ID --project=PROJECT --data-file=-

  3. Update AWS SSM with the new Share 1 value

  The "latest" version alias automatically points to the newest version.

${colors.bold}PREREQUISITES:${colors.reset}
  - gcloud CLI installed (https://cloud.google.com/sdk/docs/install)
  - Authenticated: gcloud auth login
  - Project access: Owner or Editor role on the target GCP project(s)

${colors.bold}WHAT THIS SCRIPT DOES:${colors.reset}
  1. Reads the shard manifest to determine which secrets to create
  2. Enables required GCP APIs (Secret Manager, IAM, STS, etc.)
  3. Creates secrets for storing Shamir Share 2 values
  4. Creates a service account for AWS to access secrets
  5. Sets up Workload Identity Federation for cross-cloud auth
  6. Configures audit logging

${colors.bold}EXAMPLES:${colors.reset}
  # Use the example manifest
  npx ts-node scripts/gcp-shard-setup.ts --manifest packages/core/src/shard/shard-manifest.example.json

  # Use a production manifest
  npx ts-node scripts/gcp-shard-setup.ts -m config/shard-manifest.json

${colors.bold}MANIFEST FORMAT:${colors.reset}
  {
    "version": "1.0",
    "shardedFields": [
      {
        "path": "web3_signer_private_key",
        "gcpSecretRef": {
          "project": "my-gcp-project",
          "secretId": "mark-web3-signer-pk-share2"
        },
        "method": "shamir",
        "required": true
      }
    ]
  }

${colors.bold}SECURITY:${colors.reset}
  - This script does NOT handle actual secret values
  - Share 2 values must be populated separately after setup
  - All secret access is logged via GCP audit logs
`;

// ============================================================================
// Types
// ============================================================================

interface ShardManifest {
  version: string;
  description?: string;
  shardedFields: ShardedField[];
}

interface ShardedField {
  path: string;
  gcpSecretRef: {
    project: string;
    secretId: string;
    version?: string;
  };
  method: 'shamir' | 'xor' | 'concat';
  required?: boolean;
  _comment?: string;
}

interface ProjectConfig {
  projectId: string;
  secrets: SecretConfig[];
}

interface SecretConfig {
  secretId: string;
  path: string;
  required: boolean;
  comment?: string;
}

interface SetupConfig {
  projects: ProjectConfig[];
  serviceName: string;
  awsAccountId: string;
  awsRoleName: string;
  environment: 'staging' | 'production';
}

interface SetupResult {
  step: string;
  status: 'created' | 'exists' | 'skipped' | 'failed';
  message: string;
}

// ============================================================================
// Console UI Functions
// ============================================================================

function print(message: string): void {
  console.log(message);
}

function printHeader(title: string): void {
  const line = '═'.repeat(60);
  print('');
  print(`${colors.cyan}${line}${colors.reset}`);
  print(`${colors.cyan}║${colors.reset} ${colors.bold}${title}${colors.reset}`);
  print(`${colors.cyan}${line}${colors.reset}`);
  print('');
}

function printSection(title: string): void {
  print('');
  print(`${colors.blue}▶ ${title}${colors.reset}`);
  print(`${colors.dim}${'─'.repeat(50)}${colors.reset}`);
}

function printStep(message: string): void {
  print(`  ${colors.dim}○${colors.reset} ${message}`);
}

function printSuccess(message: string): void {
  print(`  ${colors.green}✓${colors.reset} ${message}`);
}

function printSkip(message: string): void {
  print(`  ${colors.yellow}○${colors.reset} ${message} ${colors.dim}(already exists)${colors.reset}`);
}

function printError(message: string): void {
  print(`  ${colors.red}✗${colors.reset} ${message}`);
}

function printWarning(message: string): void {
  print(`${colors.yellow}⚠ ${message}${colors.reset}`);
}

function printInfo(message: string): void {
  print(`${colors.dim}  ℹ ${message}${colors.reset}`);
}

// ============================================================================
// Readline Prompts
// ============================================================================

class Prompter {
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const defaultHint = defaultValue ? ` ${colors.dim}(${defaultValue})${colors.reset}` : '';
    const prompt = `${colors.cyan}?${colors.reset} ${question}${defaultHint}: `;

    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        const value = answer.trim() || defaultValue || '';
        resolve(value);
      });
    });
  }

  async confirm(question: string, defaultValue: boolean = true): Promise<boolean> {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const prompt = `${colors.cyan}?${colors.reset} ${question} ${colors.dim}(${hint})${colors.reset}: `;

    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (normalized === '') {
          resolve(defaultValue);
        } else {
          resolve(normalized === 'y' || normalized === 'yes');
        }
      });
    });
  }

  async select(question: string, options: string[], defaultIndex: number = 0): Promise<string> {
    print(`${colors.cyan}?${colors.reset} ${question}`);
    options.forEach((opt, i) => {
      const marker = i === defaultIndex ? `${colors.cyan}❯${colors.reset}` : ' ';
      print(`  ${marker} ${i + 1}) ${opt}`);
    });

    return new Promise((resolve) => {
      this.rl.question(`${colors.dim}Enter number (1-${options.length})${colors.reset}: `, (answer) => {
        const index = parseInt(answer.trim(), 10) - 1;
        if (index >= 0 && index < options.length) {
          resolve(options[index]);
        } else {
          resolve(options[defaultIndex]);
        }
      });
    });
  }

  close(): void {
    this.rl.close();
  }
}

// ============================================================================
// Manifest Parsing
// ============================================================================

function loadManifest(manifestPath: string): ShardManifest {
  const absolutePath = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.resolve(process.cwd(), manifestPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Manifest file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');

  try {
    const manifest = JSON.parse(content) as ShardManifest;

    // Validate manifest structure
    if (!manifest.version) {
      throw new Error('Manifest missing required field: version');
    }

    if (!Array.isArray(manifest.shardedFields)) {
      throw new Error('Manifest missing required field: shardedFields (must be an array)');
    }

    // Validate each field
    for (const field of manifest.shardedFields) {
      if (!field.path) {
        throw new Error('Sharded field missing required field: path');
      }
      if (!field.gcpSecretRef?.project) {
        throw new Error(`Sharded field '${field.path}' missing gcpSecretRef.project`);
      }
      if (!field.gcpSecretRef?.secretId) {
        throw new Error(`Sharded field '${field.path}' missing gcpSecretRef.secretId`);
      }
    }

    return manifest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest file: ${error.message}`);
    }
    throw error;
  }
}

function groupSecretsByProject(manifest: ShardManifest): Map<string, SecretConfig[]> {
  const projectSecrets = new Map<string, SecretConfig[]>();

  for (const field of manifest.shardedFields) {
    const project = field.gcpSecretRef.project;
    const secret: SecretConfig = {
      secretId: field.gcpSecretRef.secretId,
      path: field.path,
      required: field.required !== false, // default to true
      comment: field._comment,
    };

    if (!projectSecrets.has(project)) {
      projectSecrets.set(project, []);
    }
    projectSecrets.get(project)!.push(secret);
  }

  return projectSecrets;
}

// ============================================================================
// GCloud Command Helpers
// ============================================================================

function runGcloud(args: string[], silent: boolean = false): { success: boolean; output: string; error: string } {
  try {
    const result = spawnSync('gcloud', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      success: result.status === 0,
      output: result.stdout || '',
      error: result.stderr || '',
    };
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runGcloudJson<T>(args: string[]): { success: boolean; data: T | null; error: string } {
  const result = runGcloud([...args, '--format=json']);
  if (result.success && result.output) {
    try {
      return { success: true, data: JSON.parse(result.output) as T, error: '' };
    } catch {
      return { success: false, data: null, error: 'Failed to parse JSON output' };
    }
  }
  return { success: false, data: null, error: result.error };
}

function checkGcloudInstalled(): boolean {
  const result = runGcloud(['version']);
  return result.success;
}

function checkGcloudAuth(): boolean {
  const result = runGcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  return result.success && result.output.trim().length > 0;
}

function getProjectNumber(projectId: string): string | null {
  const result = runGcloud(['projects', 'describe', projectId, '--format=value(projectNumber)']);
  return result.success ? result.output.trim() : null;
}

// ============================================================================
// Resource Existence Checks
// ============================================================================

function secretExists(projectId: string, secretId: string): boolean {
  const result = runGcloud(['secrets', 'describe', secretId, `--project=${projectId}`], true);
  return result.success;
}

function serviceAccountExists(projectId: string, accountId: string): boolean {
  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
  const result = runGcloud(['iam', 'service-accounts', 'describe', email, `--project=${projectId}`], true);
  return result.success;
}

function workloadPoolExists(projectId: string, poolId: string): boolean {
  const result = runGcloud([
    'iam',
    'workload-identity-pools',
    'describe',
    poolId,
    `--project=${projectId}`,
    '--location=global',
  ], true);
  return result.success;
}

function workloadProviderExists(projectId: string, poolId: string, providerId: string): boolean {
  const result = runGcloud([
    'iam',
    'workload-identity-pools',
    'providers',
    'describe',
    providerId,
    `--project=${projectId}`,
    '--location=global',
    `--workload-identity-pool=${poolId}`,
  ], true);
  return result.success;
}

function apiEnabled(projectId: string, apiName: string): boolean {
  const result = runGcloud([
    'services',
    'list',
    `--project=${projectId}`,
    `--filter=config.name:${apiName}`,
    '--format=value(config.name)',
  ]);
  return result.success && result.output.includes(apiName);
}

// ============================================================================
// Setup Functions
// ============================================================================

async function enableApis(projectId: string): Promise<SetupResult[]> {
  const apis = [
    'secretmanager.googleapis.com',
    'iam.googleapis.com',
    'iamcredentials.googleapis.com',
    'cloudresourcemanager.googleapis.com',
    'sts.googleapis.com',
  ];

  const results: SetupResult[] = [];

  for (const api of apis) {
    printStep(`Checking ${api}...`);

    if (apiEnabled(projectId, api)) {
      printSkip(api);
      results.push({ step: `API: ${api}`, status: 'exists', message: 'Already enabled' });
    } else {
      const result = runGcloud(['services', 'enable', api, `--project=${projectId}`]);
      if (result.success) {
        printSuccess(`Enabled ${api}`);
        results.push({ step: `API: ${api}`, status: 'created', message: 'Enabled' });
      } else {
        printError(`Failed to enable ${api}: ${result.error}`);
        results.push({ step: `API: ${api}`, status: 'failed', message: result.error });
      }
    }
  }

  return results;
}

async function createSecrets(projectId: string, secrets: SecretConfig[], serviceName: string, environment: string): Promise<SetupResult[]> {
  const results: SetupResult[] = [];

  for (const secret of secrets) {
    printStep(`Checking secret: ${secret.secretId}...`);

    if (secretExists(projectId, secret.secretId)) {
      printSkip(secret.secretId);
      results.push({ step: `Secret: ${secret.secretId}`, status: 'exists', message: 'Already exists' });
    } else {
      const result = runGcloud([
        'secrets',
        'create',
        secret.secretId,
        `--project=${projectId}`,
        '--replication-policy=automatic',
        `--labels=environment=${environment},service=${serviceName},purpose=shamir-share-2,required=${secret.required},config-path=${secret.path.replace(/[^a-z0-9-_]/gi, '_').toLowerCase()}`,
      ]);

      if (result.success) {
        printSuccess(`Created ${secret.secretId}`);
        results.push({ step: `Secret: ${secret.secretId}`, status: 'created', message: 'Created' });
      } else {
        printError(`Failed to create ${secret.secretId}: ${result.error}`);
        results.push({ step: `Secret: ${secret.secretId}`, status: 'failed', message: result.error });
      }
    }
  }

  return results;
}

async function createServiceAccount(projectId: string, secrets: SecretConfig[], serviceName: string): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const accountId = `${serviceName}-shamir-reader`;
  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;

  printStep(`Checking service account: ${accountId}...`);

  if (serviceAccountExists(projectId, accountId)) {
    printSkip(accountId);
    results.push({ step: `Service Account: ${accountId}`, status: 'exists', message: 'Already exists' });
  } else {
    const result = runGcloud([
      'iam',
      'service-accounts',
      'create',
      accountId,
      `--project=${projectId}`,
      `--display-name=${serviceName} Shamir Share Reader`,
      `--description=Service account for AWS ${serviceName} service to read Shamir Share 2 secrets`,
    ]);

    if (result.success) {
      printSuccess(`Created service account: ${accountId}`);
      results.push({ step: `Service Account: ${accountId}`, status: 'created', message: 'Created' });
    } else {
      printError(`Failed to create service account: ${result.error}`);
      results.push({ step: `Service Account: ${accountId}`, status: 'failed', message: result.error });
      return results; // Can't continue without service account
    }
  }

  // Grant secret accessor role for each secret
  printStep('Granting secret access permissions...');

  for (const secret of secrets) {
    // Check if binding already exists (by checking policy)
    const policyResult = runGcloudJson<{ bindings?: Array<{ role: string; members: string[] }> }>([
      'secrets',
      'get-iam-policy',
      secret.secretId,
      `--project=${projectId}`,
    ]);

    const alreadyBound = policyResult.data?.bindings?.some(
      (b) => b.role === 'roles/secretmanager.secretAccessor' && b.members?.includes(`serviceAccount:${email}`)
    );

    if (alreadyBound) {
      printInfo(`${secret.secretId}: already has access`);
    } else {
      const bindResult = runGcloud([
        'secrets',
        'add-iam-policy-binding',
        secret.secretId,
        `--project=${projectId}`,
        `--member=serviceAccount:${email}`,
        '--role=roles/secretmanager.secretAccessor',
      ]);

      if (bindResult.success) {
        printSuccess(`Granted access to ${secret.secretId}`);
      } else {
        printError(`Failed to grant access to ${secret.secretId}: ${bindResult.error}`);
      }
    }
  }

  return results;
}

async function createWorkloadIdentity(
  projectId: string,
  serviceName: string,
  awsAccountId: string,
  awsRoleName: string,
  environment: string,
  force: boolean = false
): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const poolId = `${serviceName}-aws-pool`;
  const providerId = `aws-${environment}`;
  const accountId = `${serviceName}-shamir-reader`;
  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;

  // Create Workload Identity Pool
  printStep(`Checking Workload Identity Pool: ${poolId}...`);

  if (workloadPoolExists(projectId, poolId)) {
    printSkip(poolId);
    results.push({ step: `Workload Pool: ${poolId}`, status: 'exists', message: 'Already exists' });
  } else {
    const result = runGcloud([
      'iam',
      'workload-identity-pools',
      'create',
      poolId,
      `--project=${projectId}`,
      '--location=global',
      `--display-name=${serviceName} AWS Workload Pool`,
      `--description=Identity pool for AWS ${serviceName} workloads to access GCP resources`,
    ]);

    if (result.success) {
      printSuccess(`Created Workload Identity Pool: ${poolId}`);
      results.push({ step: `Workload Pool: ${poolId}`, status: 'created', message: 'Created' });
    } else {
      printError(`Failed to create pool: ${result.error}`);
      results.push({ step: `Workload Pool: ${poolId}`, status: 'failed', message: result.error });
      return results;
    }
  }

  // Create or Update AWS Provider
  printStep(`Checking AWS Provider: ${providerId}...`);

  const providerExists = workloadProviderExists(projectId, poolId, providerId);

  if (providerExists && !force) {
    printSkip(providerId);
    results.push({ step: `AWS Provider: ${providerId}`, status: 'exists', message: 'Already exists' });
  } else if (providerExists && force) {
    // Update existing provider
    printStep(`Updating AWS Provider: ${providerId} (--force)...`);
    const result = runGcloud([
      'iam',
      'workload-identity-pools',
      'providers',
      'update-aws',
      providerId,
      `--project=${projectId}`,
      '--location=global',
      `--workload-identity-pool=${poolId}`,
      `--account-id=${awsAccountId}`,
      `--display-name=AWS ${environment} Provider`,
    ]);

    if (result.success) {
      printSuccess(`Updated AWS Provider: ${providerId}`);
      results.push({ step: `AWS Provider: ${providerId}`, status: 'created', message: 'Updated (force)' });
    } else {
      printError(`Failed to update provider: ${result.error}`);
      results.push({ step: `AWS Provider: ${providerId}`, status: 'failed', message: result.error });
    }
  } else {
    // Create new provider
    const result = runGcloud([
      'iam',
      'workload-identity-pools',
      'providers',
      'create-aws',
      providerId,
      `--project=${projectId}`,
      '--location=global',
      `--workload-identity-pool=${poolId}`,
      `--account-id=${awsAccountId}`,
      `--display-name=AWS ${environment} Provider`,
    ]);

    if (result.success) {
      printSuccess(`Created AWS Provider: ${providerId}`);
      results.push({ step: `AWS Provider: ${providerId}`, status: 'created', message: 'Created' });
    } else {
      printError(`Failed to create provider: ${result.error}`);
      results.push({ step: `AWS Provider: ${providerId}`, status: 'failed', message: result.error });
    }
  }

  // Bind service account to workload identity
  printStep('Configuring service account binding...');

  const projectNumber = getProjectNumber(projectId);
  if (!projectNumber) {
    printError('Failed to get project number');
    return results;
  }

  const member = `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/attribute.aws_role/${awsRoleName}`;

  // Check existing bindings
  const policyResult = runGcloudJson<{ bindings?: Array<{ role: string; members: string[] }> }>([
    'iam',
    'service-accounts',
    'get-iam-policy',
    email,
    `--project=${projectId}`,
  ]);

  const alreadyBound = policyResult.data?.bindings?.some(
    (b) => b.role === 'roles/iam.workloadIdentityUser' && b.members?.some((m) => m.includes(poolId))
  );

  if (alreadyBound && !force) {
    printSkip('Service account binding');
    results.push({ step: 'SA Binding', status: 'exists', message: 'Already bound' });
  } else {
    if (alreadyBound && force) {
      printStep('Re-binding service account (--force)...');
    }
    
    const bindResult = runGcloud([
      'iam',
      'service-accounts',
      'add-iam-policy-binding',
      email,
      `--project=${projectId}`,
      '--role=roles/iam.workloadIdentityUser',
      `--member=${member}`,
    ]);

    if (bindResult.success) {
      printSuccess('Bound service account to workload identity');
      results.push({ step: 'SA Binding', status: 'created', message: force ? 'Re-bound (force)' : 'Bound' });
    } else {
      // IAM bindings are idempotent, so this might just mean no change needed
      if (bindResult.error.includes('already exists') || alreadyBound) {
        printSkip('Service account binding (no change needed)');
        results.push({ step: 'SA Binding', status: 'exists', message: 'No change needed' });
      } else {
        printError(`Failed to bind: ${bindResult.error}`);
        results.push({ step: 'SA Binding', status: 'failed', message: bindResult.error });
      }
    }
  }

  return results;
}

async function enableAuditLogging(projectId: string): Promise<SetupResult[]> {
  const results: SetupResult[] = [];

  printStep('Configuring audit logging for Secret Manager...');

  // Get current IAM policy
  const policyResult = runGcloudJson<{
    auditConfigs?: Array<{ service: string; auditLogConfigs: Array<{ logType: string }> }>;
  }>(['projects', 'get-iam-policy', projectId]);

  const existingConfig = policyResult.data?.auditConfigs?.find(
    (c) => c.service === 'secretmanager.googleapis.com'
  );

  if (existingConfig) {
    printSkip('Audit logging');
    results.push({ step: 'Audit Logging', status: 'exists', message: 'Already configured' });
  } else {
    printInfo('Audit logging should be configured manually or via Terraform');
    printInfo('Run: gcloud projects get-iam-policy PROJECT > policy.json');
    printInfo('Then add auditConfigs for secretmanager.googleapis.com');
    results.push({ step: 'Audit Logging', status: 'skipped', message: 'Manual configuration needed' });
  }

  return results;
}

// ============================================================================
// Summary Output
// ============================================================================

function printSummary(config: SetupConfig, results: SetupResult[], manifest: ShardManifest): void {
  printHeader('Setup Summary');

  const created = results.filter((r) => r.status === 'created').length;
  const exists = results.filter((r) => r.status === 'exists').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  print(`${colors.green}Created:${colors.reset} ${created}`);
  print(`${colors.yellow}Already existed:${colors.reset} ${exists}`);
  print(`${colors.dim}Skipped:${colors.reset} ${skipped}`);
  if (failed > 0) {
    print(`${colors.red}Failed:${colors.reset} ${failed}`);
  }

  if (failed > 0) {
    printSection('Failed Steps');
    results
      .filter((r) => r.status === 'failed')
      .forEach((r) => {
        printError(`${r.step}: ${r.message}`);
      });
  }

  // Print per-project configuration for AWS admin
  for (const project of config.projects) {
    const projectNumber = getProjectNumber(project.projectId);

    printSection(`Configuration for AWS Admin (${project.projectId})`);

    print(`
${colors.bold}Add to AWS environment/config:${colors.reset}

  GCP_PROJECT_ID=${project.projectId}
  GCP_SERVICE_ACCOUNT=${config.serviceName}-shamir-reader@${project.projectId}.iam.gserviceaccount.com
  GCP_WORKLOAD_POOL=projects/${projectNumber}/locations/global/workloadIdentityPools/${config.serviceName}-aws-pool
  GCP_WORKLOAD_PROVIDER=projects/${projectNumber}/locations/global/workloadIdentityPools/${config.serviceName}-aws-pool/providers/aws-${config.environment}
`);
  }

  printSection('Secrets Created from Manifest');

  print(`
${colors.bold}The following secrets were set up based on your manifest:${colors.reset}
`);

  for (const field of manifest.shardedFields) {
    const reqLabel = field.required !== false ? `${colors.yellow}(required)${colors.reset}` : `${colors.dim}(optional)${colors.reset}`;
    print(`  ${colors.cyan}${field.path}${colors.reset}`);
    print(`    → ${field.gcpSecretRef.project}/${field.gcpSecretRef.secretId} ${reqLabel}`);
    if (field._comment) {
      print(`    ${colors.dim}${field._comment}${colors.reset}`);
    }
  }

  printSection('Next Steps');

  print(`
  1. ${colors.bold}Share this output with the AWS admin${colors.reset}
     They need the configuration values above to set up cross-cloud auth.

  2. ${colors.bold}Populate secrets with Share 2 values${colors.reset}
     Use the shamir:split script to generate and store shares:
     ${colors.dim}yarn shamir:split --secret "YOUR_SECRET" --gcp-project PROJECT --gcp-secret SECRET_ID${colors.reset}

     Or manually for each secret:
     ${colors.dim}echo -n "SHARE2_VALUE" | gcloud secrets versions add SECRET_ID --project=PROJECT --data-file=-${colors.reset}

  3. ${colors.bold}Verify setup${colors.reset}
     ${colors.dim}gcloud secrets list --project=PROJECT --filter="labels.purpose=shamir-share-2"${colors.reset}

  4. ${colors.bold}Test secret access${colors.reset}
     ${colors.dim}gcloud secrets versions access latest --secret=SECRET_ID --project=PROJECT${colors.reset}
`);

  printSection('Key Rotation');

  print(`
  To rotate keys, you ${colors.bold}don't${colors.reset} need to re-run this script. Instead:

  1. ${colors.bold}Generate new shares for the new secret:${colors.reset}
     ${colors.dim}yarn shamir:split --secret "NEW_SECRET_VALUE" \\
       --aws-param "/mark/config/field_share1" \\
       --gcp-project PROJECT --gcp-secret SECRET_ID${colors.reset}

  2. ${colors.bold}Or add a new version manually:${colors.reset}
     ${colors.dim}# Update GCP (adds new version, "latest" auto-updates)
     echo -n "NEW_SHARE2" | gcloud secrets versions add SECRET_ID --project=PROJECT --data-file=-

     # Update AWS SSM
     aws ssm put-parameter --name "/mark/config/field_share1" --value "NEW_SHARE1" --overwrite${colors.reset}

  3. ${colors.bold}Disable old versions (optional):${colors.reset}
     ${colors.dim}gcloud secrets versions disable VERSION_ID --secret=SECRET_ID --project=PROJECT${colors.reset}

  4. ${colors.bold}If AWS role changed, re-run with --force:${colors.reset}
     ${colors.dim}yarn gcp:setup manifest.json --force${colors.reset}
`);
}


// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs(): { manifestPath?: string; help: boolean; force: boolean } {
  const args = process.argv.slice(2);
  let manifestPath: string | undefined;
  let help = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--manifest' || arg === '-m') {
      manifestPath = args[++i];
    } else if (arg.startsWith('--manifest=')) {
      manifestPath = arg.split('=')[1];
    }
  }

  return { manifestPath, help, force };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { manifestPath, help, force } = parseArgs();

  if (help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  printHeader('GCP Shard Setup');

  print(`This script sets up GCP Secret Manager infrastructure for Shamir key sharding.
It is ${colors.bold}idempotent${colors.reset} - you can run it multiple times safely.
`);

  if (force) {
    printWarning('--force mode: Will update existing Workload Identity configurations');
    print('');
  }

  // Check for manifest argument
  if (!manifestPath) {
    printError('Manifest file is required. Use --manifest <path> or -m <path>');
    print('');
    print(`Example: ${colors.dim}npx ts-node scripts/gcp-shard-setup.ts --manifest packages/core/src/shard/shard-manifest.example.json${colors.reset}`);
    print('');
    print(`Run with ${colors.dim}--help${colors.reset} for more information.`);
    process.exit(1);
  }

  // Check prerequisites
  printSection('Checking Prerequisites');

  printStep('Checking gcloud CLI...');
  if (!checkGcloudInstalled()) {
    printError('gcloud CLI is not installed. Please install it from https://cloud.google.com/sdk/docs/install');
    process.exit(1);
  }
  printSuccess('gcloud CLI is installed');

  printStep('Checking authentication...');
  if (!checkGcloudAuth()) {
    printError('Not authenticated. Please run: gcloud auth login');
    process.exit(1);
  }
  printSuccess('Authenticated with gcloud');

  // Load and validate manifest
  printSection('Loading Manifest');

  printStep(`Loading ${manifestPath}...`);
  let manifest: ShardManifest;
  try {
    manifest = loadManifest(manifestPath);
    printSuccess(`Loaded manifest v${manifest.version} with ${manifest.shardedFields.length} sharded fields`);
  } catch (error) {
    printError(`Failed to load manifest: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Group secrets by project
  const projectSecrets = groupSecretsByProject(manifest);
  const projectIds = Array.from(projectSecrets.keys());

  print('');
  print(`${colors.bold}GCP Projects in manifest:${colors.reset}`);
  for (const [projectId, secrets] of projectSecrets) {
    print(`  ${colors.cyan}${projectId}${colors.reset}: ${secrets.length} secrets`);
  }

  // Verify all projects are accessible
  printSection('Verifying Project Access');

  for (const projectId of projectIds) {
    printStep(`Verifying ${projectId}...`);
    const projectResult = runGcloud(['projects', 'describe', projectId]);
    if (!projectResult.success) {
      printError(`Project ${projectId} not found or not accessible`);
      printInfo('Make sure the project exists and you have access to it');
      process.exit(1);
    }
    printSuccess(`${projectId} is accessible`);
  }

  // Gather AWS configuration
  printSection('AWS Configuration');

  const prompter = new Prompter();

  try {
    print(`${colors.dim}The following information is needed to set up Workload Identity Federation${colors.reset}`);
    print(`${colors.dim}for AWS services to access GCP secrets.${colors.reset}`);
    print('');

    const environment = (await prompter.select('Select environment', ['staging', 'production'], 0)) as
      | 'staging'
      | 'production';

    const serviceName = await prompter.ask('Service name', 'mark');
    const awsAccountId = await prompter.ask('AWS Account ID (12 digits)');

    if (!/^\d{12}$/.test(awsAccountId)) {
      printWarning('AWS Account ID should be 12 digits. Continuing anyway...');
    }

    const awsRoleName = await prompter.ask('AWS IAM Role name', `${serviceName}-ecs-task-role`);

    // Build config
    const config: SetupConfig = {
      projects: projectIds.map((projectId) => ({
        projectId,
        secrets: projectSecrets.get(projectId)!,
      })),
      serviceName,
      awsAccountId,
      awsRoleName,
      environment,
    };

    // Show secrets from manifest
    printSection('Secrets from Manifest');

    const totalSecrets = manifest.shardedFields.length;
    const requiredSecrets = manifest.shardedFields.filter((f) => f.required !== false).length;

    print(`
  ${colors.bold}Total secrets:${colors.reset}    ${totalSecrets}
  ${colors.bold}Required:${colors.reset}         ${requiredSecrets}
  ${colors.bold}Optional:${colors.reset}         ${totalSecrets - requiredSecrets}
`);

    for (const field of manifest.shardedFields) {
      const reqLabel = field.required !== false ? `${colors.yellow}*${colors.reset}` : ' ';
      print(`  ${reqLabel} ${colors.cyan}${field.path}${colors.reset}`);
      print(`    ${colors.dim}→ ${field.gcpSecretRef.project}/${field.gcpSecretRef.secretId}${colors.reset}`);
    }

    print('');

    // Confirm before proceeding
    printSection('Review Configuration');

    print(`
  ${colors.bold}Environment:${colors.reset}      ${config.environment}
  ${colors.bold}Service Name:${colors.reset}     ${config.serviceName}
  ${colors.bold}AWS Account:${colors.reset}      ${config.awsAccountId}
  ${colors.bold}AWS Role:${colors.reset}         ${config.awsRoleName}
  ${colors.bold}GCP Projects:${colors.reset}     ${projectIds.join(', ')}
  ${colors.bold}Total Secrets:${colors.reset}    ${totalSecrets}
`);

    const proceed = await prompter.confirm('Proceed with setup?', true);

    if (!proceed) {
      print('\nSetup cancelled.');
      process.exit(0);
    }

    // Run setup for each project
    const allResults: SetupResult[] = [];

    for (const project of config.projects) {
      printHeader(`Setting up ${project.projectId}`);

      printSection('Enabling APIs');
      allResults.push(...(await enableApis(project.projectId)));

      printSection('Creating Secrets');
      allResults.push(...(await createSecrets(project.projectId, project.secrets, config.serviceName, config.environment)));

      printSection('Creating Service Account');
      allResults.push(...(await createServiceAccount(project.projectId, project.secrets, config.serviceName)));

      printSection('Setting up Workload Identity Federation');
      allResults.push(...(await createWorkloadIdentity(
        project.projectId,
        config.serviceName,
        config.awsAccountId,
        config.awsRoleName,
        config.environment,
        force
      )));

      printSection('Configuring Audit Logging');
      allResults.push(...(await enableAuditLogging(project.projectId)));
    }

    // Print summary
    printSummary(config, allResults, manifest);

    const hasFailures = allResults.some((r) => r.status === 'failed');
    process.exit(hasFailures ? 1 : 0);
  } finally {
    prompter.close();
  }
}

main().catch((error) => {
  printError(`Unexpected error: ${error.message}`);
  process.exit(1);
});
