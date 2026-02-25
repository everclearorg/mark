#!/usr/bin/env npx ts-node
/**
 * AWS Shard Setup Script
 *
 * Interactive, idempotent script to set up AWS SSM Parameter Store infrastructure
 * for Shamir key sharding. Creates SSM parameters for Share 1 values and configures
 * IAM permissions for the ECS task role to access them.
 *
 * Usage:
 *   npx ts-node scripts/aws-shard-setup.ts --manifest path/to/manifest.json
 *
 * Requirements:
 *   - AWS CLI installed and configured
 *   - Appropriate AWS permissions (IAM, SSM)
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
${colors.bold}AWS Shard Setup${colors.reset}

Interactive, idempotent script to set up AWS SSM Parameter Store infrastructure
for Shamir key sharding. Creates SSM parameters for Share 1 values.

${colors.bold}USAGE:${colors.reset}
  npx ts-node scripts/aws-shard-setup.ts [OPTIONS]

${colors.bold}OPTIONS:${colors.reset}
  --manifest, -m <path>   Path to shard manifest JSON file (required)
  --region, -r <region>   AWS region (default: from manifest, then AWS_REGION, then us-east-1)
  --profile, -p <name>    AWS CLI profile to use
  --prefix <path>         SSM parameter path prefix (default: from manifest awsConfig.parameterPrefix)
  --force                 Force update of IAM policies
  --help, -h              Show this help message

${colors.bold}KEY ROTATION:${colors.reset}
  For key rotation, you don't re-run this script - instead:

  1. Generate new shares:
     yarn shamir:split --secret "NEW_SECRET" --aws-param "/mark/config/field_share1"

  2. Or manually update the parameter:
     aws ssm put-parameter --name "/mark/config/field_share1" --value "NEW_SHARE1" \\
       --type SecureString --overwrite

${colors.bold}PREREQUISITES:${colors.reset}
  - AWS CLI installed (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  - Configured: aws configure (or use --profile)
  - IAM permissions: ssm:*, iam:* on relevant resources

${colors.bold}WHAT THIS SCRIPT DOES:${colors.reset}
  1. Reads the shard manifest to determine which parameters to create
  2. Creates SSM SecureString parameters for Share 1 values
  3. Optionally creates/updates IAM policy for ECS task role access
  4. Tags parameters for organization and auditing

${colors.bold}EXAMPLES:${colors.reset}
  # Use the example manifest
  npx ts-node scripts/aws-shard-setup.ts --manifest packages/core/src/shard/shard-manifest.example.json

  # Use a specific region and profile
  npx ts-node scripts/aws-shard-setup.ts -m manifest.json --region us-west-2 --profile prod

  # Custom SSM path prefix
  npx ts-node scripts/aws-shard-setup.ts -m manifest.json --prefix /myapp/secrets

${colors.bold}SECURITY:${colors.reset}
  - Parameters are created as SecureString (encrypted with KMS)
  - This script does NOT handle actual secret values
  - Share 1 values must be populated separately after setup
`;

// ============================================================================
// Types
// ============================================================================

interface AwsManifestConfig {
  region?: string;
  parameterPrefix?: string;
}

interface GcpManifestConfig {
  project?: string;
}

interface ShardManifest {
  version: string;
  description?: string;
  awsConfig?: AwsManifestConfig;
  gcpConfig?: GcpManifestConfig;
  shardedFields: ShardedField[];
}

interface ShardedField {
  path: string;
  awsParamName?: string;
  gcpSecretRef: {
    project: string;
    secretId: string;
    version?: string;
  };
  method: 'shamir' | 'xor' | 'concat';
  required?: boolean;
  _comment?: string;
}

interface ParameterConfig {
  name: string;
  path: string;
  required: boolean;
  comment?: string;
}

interface SetupConfig {
  parameters: ParameterConfig[];
  region: string;
  profile?: string;
  prefix: string;
  serviceName: string;
  environment: 'staging' | 'production';
  ecsTaskRoleName: string;
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
    }

    return manifest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest file: ${error.message}`);
    }
    throw error;
  }
}

function manifestToParameters(manifest: ShardManifest, prefix: string): ParameterConfig[] {
  return manifest.shardedFields.map((field) => {
    // Use explicit awsParamName if provided, otherwise derive from path
    let paramName: string;
    
    if (field.awsParamName) {
      // Use the explicit name from manifest
      paramName = field.awsParamName;
    } else {
      // Derive from config path
      // e.g., "web3_signer_private_key" -> "/mark/config/web3_signer_private_key_share1"
      // e.g., "chains.1.privateKey" -> "/mark/config/chains_1_privateKey_share1"
      const safePath = field.path.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
      paramName = `${prefix}/${safePath}_share1`;
    }

    return {
      name: paramName,
      path: field.path,
      required: field.required !== false,
      comment: field._comment,
    };
  });
}

// ============================================================================
// AWS Command Helpers
// ============================================================================

function runAws(
  args: string[],
  options: { region?: string; profile?: string; silent?: boolean } = {}
): { success: boolean; output: string; error: string } {
  const fullArgs = [...args];

  if (options.region) {
    fullArgs.push('--region', options.region);
  }
  if (options.profile) {
    fullArgs.push('--profile', options.profile);
  }

  try {
    const result = spawnSync('aws', fullArgs, {
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

function runAwsJson<T>(
  args: string[],
  options: { region?: string; profile?: string } = {}
): { success: boolean; data: T | null; error: string } {
  const result = runAws([...args, '--output', 'json'], options);
  if (result.success && result.output) {
    try {
      return { success: true, data: JSON.parse(result.output) as T, error: '' };
    } catch {
      return { success: false, data: null, error: 'Failed to parse JSON output' };
    }
  }
  return { success: false, data: null, error: result.error };
}

function checkAwsInstalled(): boolean {
  const result = runAws(['--version']);
  return result.success;
}

function checkAwsAuth(options: { region?: string; profile?: string } = {}): boolean {
  const result = runAws(['sts', 'get-caller-identity'], options);
  return result.success;
}

function getAwsAccountId(options: { region?: string; profile?: string } = {}): string | null {
  const result = runAwsJson<{ Account: string }>(['sts', 'get-caller-identity'], options);
  return result.data?.Account || null;
}

function getAwsRegion(options: { profile?: string } = {}): string {
  // Try to get from environment first
  if (process.env.AWS_REGION) {
    return process.env.AWS_REGION;
  }
  if (process.env.AWS_DEFAULT_REGION) {
    return process.env.AWS_DEFAULT_REGION;
  }

  // Try to get from AWS config
  const result = runAws(['configure', 'get', 'region'], options);
  if (result.success && result.output.trim()) {
    return result.output.trim();
  }

  return 'us-east-1';
}

// ============================================================================
// Resource Existence Checks
// ============================================================================

function parameterExists(
  paramName: string,
  options: { region?: string; profile?: string }
): boolean {
  const result = runAws(
    ['ssm', 'describe-parameters', '--parameter-filters', `Key=Name,Values=${paramName}`],
    { ...options, silent: true }
  );

  if (!result.success) {
    return false;
  }

  try {
    const data = JSON.parse(result.output);
    return data.Parameters && data.Parameters.length > 0;
  } catch {
    return false;
  }
}

function iamRoleExists(
  roleName: string,
  options: { region?: string; profile?: string }
): boolean {
  const result = runAws(['iam', 'get-role', '--role-name', roleName], { ...options, silent: true });
  return result.success;
}

function iamPolicyExists(
  policyArn: string,
  options: { region?: string; profile?: string }
): boolean {
  const result = runAws(['iam', 'get-policy', '--policy-arn', policyArn], { ...options, silent: true });
  return result.success;
}

// ============================================================================
// Setup Functions
// ============================================================================

async function createParameters(
  config: SetupConfig
): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const awsOptions = { region: config.region, profile: config.profile };

  for (const param of config.parameters) {
    printStep(`Checking parameter: ${param.name}...`);

    if (parameterExists(param.name, awsOptions)) {
      printSkip(param.name);
      results.push({ step: `Parameter: ${param.name}`, status: 'exists', message: 'Already exists' });
    } else {
      // Create parameter with a placeholder value
      // The actual share value will be populated later
      const tags = [
        `Key=Environment,Value=${config.environment}`,
        `Key=Service,Value=${config.serviceName}`,
        `Key=Purpose,Value=shamir-share-1`,
        `Key=ConfigPath,Value=${param.path.replace(/[^a-zA-Z0-9-_.]/g, '_')}`,
        `Key=Required,Value=${param.required}`,
        `Key=ManagedBy,Value=aws-shard-setup`,
      ];

      const result = runAws(
        [
          'ssm',
          'put-parameter',
          '--name', param.name,
          '--description', param.comment || `Shamir Share 1 for ${param.path}`,
          '--type', 'SecureString',
          '--value', 'PLACEHOLDER_VALUE_REPLACE_WITH_ACTUAL_SHARE',
          '--tags', ...tags,
        ],
        awsOptions
      );

      if (result.success) {
        printSuccess(`Created ${param.name}`);
        printInfo('Value is a placeholder - populate with actual share value');
        results.push({ step: `Parameter: ${param.name}`, status: 'created', message: 'Created (placeholder)' });
      } else {
        printError(`Failed to create ${param.name}: ${result.error}`);
        results.push({ step: `Parameter: ${param.name}`, status: 'failed', message: result.error });
      }
    }
  }

  return results;
}

async function createIamPolicy(
  config: SetupConfig,
  accountId: string,
  force: boolean
): Promise<{ results: SetupResult[]; policyArn: string }> {
  const results: SetupResult[] = [];
  const awsOptions = { region: config.region, profile: config.profile };
  const policyName = `${config.serviceName}-shamir-share-access`;
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

  printStep(`Checking IAM policy: ${policyName}...`);

  // Build policy document
  const parameterArns = config.parameters.map(
    (p) => `arn:aws:ssm:${config.region}:${accountId}:parameter${p.name}`
  );

  const policyDocument = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowReadShamirShare1Parameters',
        Effect: 'Allow',
        Action: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:GetParametersByPath',
        ],
        Resource: parameterArns,
      },
      {
        Sid: 'AllowDecryptWithDefaultKey',
        Effect: 'Allow',
        Action: ['kms:Decrypt'],
        Resource: '*',
        Condition: {
          StringEquals: {
            'kms:ViaService': `ssm.${config.region}.amazonaws.com`,
          },
        },
      },
    ],
  };

  const policyExists = iamPolicyExists(policyArn, awsOptions);

  if (policyExists && !force) {
    printSkip(policyName);
    results.push({ step: `IAM Policy: ${policyName}`, status: 'exists', message: 'Already exists' });
  } else if (policyExists && force) {
    // Update existing policy by creating a new version
    printStep(`Updating IAM policy: ${policyName} (--force)...`);

    // First, delete old versions if we have 5 (max allowed)
    const versionsResult = runAwsJson<{ Versions: Array<{ VersionId: string; IsDefaultVersion: boolean }> }>(
      ['iam', 'list-policy-versions', '--policy-arn', policyArn],
      awsOptions
    );

    if (versionsResult.data && versionsResult.data.Versions.length >= 5) {
      // Delete the oldest non-default version
      const oldVersions = versionsResult.data.Versions
        .filter((v) => !v.IsDefaultVersion)
        .sort((a, b) => a.VersionId.localeCompare(b.VersionId));

      if (oldVersions.length > 0) {
        runAws(
          ['iam', 'delete-policy-version', '--policy-arn', policyArn, '--version-id', oldVersions[0].VersionId],
          awsOptions
        );
      }
    }

    const result = runAws(
      [
        'iam',
        'create-policy-version',
        '--policy-arn', policyArn,
        '--policy-document', JSON.stringify(policyDocument),
        '--set-as-default',
      ],
      awsOptions
    );

    if (result.success) {
      printSuccess(`Updated IAM policy: ${policyName}`);
      results.push({ step: `IAM Policy: ${policyName}`, status: 'created', message: 'Updated (force)' });
    } else {
      printError(`Failed to update policy: ${result.error}`);
      results.push({ step: `IAM Policy: ${policyName}`, status: 'failed', message: result.error });
    }
  } else {
    // Create new policy
    const result = runAws(
      [
        'iam',
        'create-policy',
        '--policy-name', policyName,
        '--description', `Allows reading Shamir Share 1 parameters for ${config.serviceName}`,
        '--policy-document', JSON.stringify(policyDocument),
        '--tags', `Key=Service,Value=${config.serviceName}`, `Key=Purpose,Value=shamir-share-access`,
      ],
      awsOptions
    );

    if (result.success) {
      printSuccess(`Created IAM policy: ${policyName}`);
      results.push({ step: `IAM Policy: ${policyName}`, status: 'created', message: 'Created' });
    } else {
      printError(`Failed to create policy: ${result.error}`);
      results.push({ step: `IAM Policy: ${policyName}`, status: 'failed', message: result.error });
    }
  }

  return { results, policyArn };
}

async function attachPolicyToRole(
  config: SetupConfig,
  policyArn: string
): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const awsOptions = { region: config.region, profile: config.profile };

  printStep(`Checking role attachment: ${config.ecsTaskRoleName}...`);

  // Check if role exists
  if (!iamRoleExists(config.ecsTaskRoleName, awsOptions)) {
    printWarning(`Role ${config.ecsTaskRoleName} does not exist yet`);
    printInfo('The policy will need to be attached manually after the role is created');
    printInfo(`Command: aws iam attach-role-policy --role-name ${config.ecsTaskRoleName} --policy-arn ${policyArn}`);
    results.push({ step: `Role Attachment`, status: 'skipped', message: 'Role does not exist' });
    return results;
  }

  // Check if policy is already attached
  const attachedResult = runAwsJson<{ AttachedPolicies: Array<{ PolicyArn: string }> }>(
    ['iam', 'list-attached-role-policies', '--role-name', config.ecsTaskRoleName],
    awsOptions
  );

  const alreadyAttached = attachedResult.data?.AttachedPolicies?.some(
    (p) => p.PolicyArn === policyArn
  );

  if (alreadyAttached) {
    printSkip(`Policy attached to ${config.ecsTaskRoleName}`);
    results.push({ step: `Role Attachment`, status: 'exists', message: 'Already attached' });
  } else {
    const result = runAws(
      ['iam', 'attach-role-policy', '--role-name', config.ecsTaskRoleName, '--policy-arn', policyArn],
      awsOptions
    );

    if (result.success) {
      printSuccess(`Attached policy to ${config.ecsTaskRoleName}`);
      results.push({ step: `Role Attachment`, status: 'created', message: 'Attached' });
    } else {
      printError(`Failed to attach policy: ${result.error}`);
      results.push({ step: `Role Attachment`, status: 'failed', message: result.error });
    }
  }

  return results;
}

// ============================================================================
// Summary Output
// ============================================================================

function printSummary(config: SetupConfig, results: SetupResult[], accountId: string): void {
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

  printSection('Configuration for GCP Admin');

  print(`
${colors.bold}Provide these values to the GCP admin for Workload Identity setup:${colors.reset}

  AWS_ACCOUNT_ID=${accountId}
  AWS_REGION=${config.region}
  AWS_ROLE_NAME=${config.ecsTaskRoleName}
`);

  printSection('Parameters Created');

  print(`
${colors.bold}SSM Parameters (all need Share 1 values populated):${colors.reset}
`);

  for (const param of config.parameters) {
    const reqLabel = param.required ? `${colors.yellow}(required)${colors.reset}` : `${colors.dim}(optional)${colors.reset}`;
    print(`  ${colors.cyan}${param.name}${colors.reset} ${reqLabel}`);
    print(`    ${colors.dim}Config path: ${param.path}${colors.reset}`);
  }

  printSection('Next Steps');

  print(`
  1. ${colors.bold}Populate parameters with Share 1 values${colors.reset}
     Use the shamir:split script to generate and store shares:
     ${colors.dim}yarn shamir:split --secret "YOUR_SECRET" --aws-param "${config.parameters[0]?.name || '/mark/config/field_share1'}"${colors.reset}

     Or manually for each parameter:
     ${colors.dim}aws ssm put-parameter --name "PARAM_NAME" --value "SHARE1_VALUE" --type SecureString --overwrite${colors.reset}

  2. ${colors.bold}Verify parameters${colors.reset}
     ${colors.dim}aws ssm describe-parameters --parameter-filters "Key=tag:Purpose,Values=shamir-share-1"${colors.reset}

  3. ${colors.bold}Test parameter access${colors.reset}
     ${colors.dim}aws ssm get-parameter --name "PARAM_NAME" --with-decryption${colors.reset}

  4. ${colors.bold}Run the GCP setup script${colors.reset}
     ${colors.dim}yarn gcp:setup manifest.json${colors.reset}
`);

  printSection('Key Rotation');

  print(`
  To rotate keys, you ${colors.bold}don't${colors.reset} need to re-run this script. Instead:

  1. ${colors.bold}Generate new shares for the new secret:${colors.reset}
     ${colors.dim}yarn shamir:split --secret "NEW_SECRET_VALUE" \\
       --aws-param "${config.parameters[0]?.name || '/mark/config/field_share1'}" \\
       --gcp-project PROJECT --gcp-secret SECRET_ID${colors.reset}

  2. ${colors.bold}Or update manually:${colors.reset}
     ${colors.dim}# Update AWS SSM (overwrites existing value)
     aws ssm put-parameter --name "PARAM_NAME" --value "NEW_SHARE1" --type SecureString --overwrite

     # Update GCP (adds new version)
     echo -n "NEW_SHARE2" | gcloud secrets versions add SECRET_ID --project=PROJECT --data-file=-${colors.reset}

  3. ${colors.bold}View parameter history:${colors.reset}
     ${colors.dim}aws ssm get-parameter-history --name "PARAM_NAME" --with-decryption${colors.reset}
`);
}

// ============================================================================
// Argument Parsing
// ============================================================================

interface ParsedArgs {
  manifestPath?: string;
  region?: string;
  profile?: string;
  prefix: string;
  prefixOverride: boolean;
  help: boolean;
  force: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const parsed: ParsedArgs = {
    prefix: '/mark/config',
    prefixOverride: false,
    help: false,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--force' || arg === '-f') {
      parsed.force = true;
    } else if (arg === '--manifest' || arg === '-m') {
      parsed.manifestPath = args[++i];
    } else if (arg.startsWith('--manifest=')) {
      parsed.manifestPath = arg.split('=')[1];
    } else if (arg === '--region' || arg === '-r') {
      parsed.region = args[++i];
    } else if (arg.startsWith('--region=')) {
      parsed.region = arg.split('=')[1];
    } else if (arg === '--profile' || arg === '-p') {
      parsed.profile = args[++i];
    } else if (arg.startsWith('--profile=')) {
      parsed.profile = arg.split('=')[1];
    } else if (arg === '--prefix') {
      parsed.prefix = args[++i];
      parsed.prefixOverride = true;
    } else if (arg.startsWith('--prefix=')) {
      parsed.prefix = arg.split('=')[1];
      parsed.prefixOverride = true;
    }
  }

  return parsed;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const parsedArgs = parseArgs();

  if (parsedArgs.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  printHeader('AWS Shard Setup');

  print(`This script sets up AWS SSM Parameter Store infrastructure for Shamir key sharding.
It is ${colors.bold}idempotent${colors.reset} - you can run it multiple times safely.
`);

  if (parsedArgs.force) {
    printWarning('--force mode: Will update existing IAM policies');
    print('');
  }

  // Check for manifest argument
  if (!parsedArgs.manifestPath) {
    printError('Manifest file is required. Use --manifest <path> or -m <path>');
    print('');
    print(`Example: ${colors.dim}npx ts-node scripts/aws-shard-setup.ts --manifest packages/core/src/shard/shard-manifest.example.json${colors.reset}`);
    print('');
    print(`Run with ${colors.dim}--help${colors.reset} for more information.`);
    process.exit(1);
  }

  // Load manifest first to get region configuration
  printSection('Loading Manifest');

  printStep(`Loading ${parsedArgs.manifestPath}...`);
  let manifest: ShardManifest;
  try {
    manifest = loadManifest(parsedArgs.manifestPath);
    printSuccess(`Loaded manifest v${manifest.version} with ${manifest.shardedFields.length} sharded fields`);
  } catch (error) {
    printError(`Failed to load manifest: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Check prerequisites
  printSection('Checking Prerequisites');

  printStep('Checking AWS CLI...');
  if (!checkAwsInstalled()) {
    printError('AWS CLI is not installed. Please install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
    process.exit(1);
  }
  printSuccess('AWS CLI is installed');

  // Determine region: CLI flag > manifest > AWS config > default
  const manifestRegion = manifest.awsConfig?.region;
  const region = parsedArgs.region || manifestRegion || getAwsRegion({ profile: parsedArgs.profile });
  
  if (manifestRegion && !parsedArgs.region) {
    printInfo(`Using region from manifest: ${manifestRegion}`);
  }
  
  const awsOptions = { region, profile: parsedArgs.profile };

  printStep(`Checking authentication (region: ${region})...`);
  if (!checkAwsAuth(awsOptions)) {
    printError('Not authenticated. Please run: aws configure');
    if (parsedArgs.profile) {
      printInfo(`Or check that profile '${parsedArgs.profile}' is correctly configured`);
    }
    process.exit(1);
  }
  printSuccess('Authenticated with AWS');

  // Get account ID
  const accountId = getAwsAccountId(awsOptions);
  if (!accountId) {
    printError('Failed to get AWS account ID');
    process.exit(1);
  }
  printSuccess(`Account ID: ${accountId}`);

  // Determine prefix: CLI flag > manifest > default
  const manifestPrefix = manifest.awsConfig?.parameterPrefix;
  const prefix = parsedArgs.prefixOverride ? parsedArgs.prefix : (manifestPrefix || parsedArgs.prefix);
  
  if (manifestPrefix && !parsedArgs.prefixOverride) {
    printInfo(`Using prefix from manifest: ${manifestPrefix}`);
  }

  // Convert manifest to parameters
  const parameters = manifestToParameters(manifest, prefix);

  print('');
  print(`${colors.bold}SSM Parameters to create:${colors.reset}`);
  for (const param of parameters) {
    const reqLabel = param.required ? `${colors.yellow}*${colors.reset}` : ' ';
    print(`  ${reqLabel} ${colors.cyan}${param.name}${colors.reset}`);
  }

  // Gather configuration
  printSection('Configuration');

  const prompter = new Prompter();

  try {
    print(`${colors.dim}The following information is needed to set up IAM permissions${colors.reset}`);
    print('');

    const environment = (await prompter.select('Select environment', ['staging', 'production'], 0)) as
      | 'staging'
      | 'production';

    const serviceName = await prompter.ask('Service name', 'mark');
    const ecsTaskRoleName = await prompter.ask('ECS Task Role name (for IAM policy attachment)', `${serviceName}-ecs-task-role`);

    const config: SetupConfig = {
      parameters,
      region,
      profile: parsedArgs.profile,
      prefix,
      serviceName,
      environment,
      ecsTaskRoleName,
    };

    // Show summary
    printSection('Review Configuration');

    print(`
  ${colors.bold}Environment:${colors.reset}      ${config.environment}
  ${colors.bold}Service Name:${colors.reset}     ${config.serviceName}
  ${colors.bold}AWS Account:${colors.reset}      ${accountId}
  ${colors.bold}AWS Region:${colors.reset}       ${config.region}
  ${colors.bold}SSM Prefix:${colors.reset}       ${config.prefix}
  ${colors.bold}ECS Task Role:${colors.reset}    ${config.ecsTaskRoleName}
  ${colors.bold}Parameters:${colors.reset}       ${config.parameters.length}
`);

    const proceed = await prompter.confirm('Proceed with setup?', true);

    if (!proceed) {
      print('\nSetup cancelled.');
      process.exit(0);
    }

    // Run setup
    const allResults: SetupResult[] = [];

    printSection('Creating SSM Parameters');
    allResults.push(...(await createParameters(config)));

    printSection('Creating IAM Policy');
    const { results: policyResults, policyArn } = await createIamPolicy(config, accountId, parsedArgs.force) as any;
    allResults.push(...policyResults);

    if (policyArn) {
      printSection('Attaching Policy to Role');
      allResults.push(...(await attachPolicyToRole(config, policyArn)));
    }

    // Print summary
    printSummary(config, allResults, accountId);

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
