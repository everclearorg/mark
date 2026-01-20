#!/usr/bin/env npx ts-node

/**
 * CLI Tool for Shamir Secret Splitting
 *
 * SECURITY WARNING: This tool handles sensitive cryptographic material.
 * - Never run in environments where terminal output is logged
 * - Use --quiet to suppress share output
 * - Clear terminal history after use
 *
 * Usage:
 *   npx ts-node scripts/shamir-split-secret.ts --help
 *
 * Examples:
 *   # Store directly in clouds (recommended - no shares displayed)
 *   npx ts-node scripts/shamir-split-secret.ts \
 *     --secret "0xabc123..." \
 *     --aws-param "/mark/web3_signer_pk_share1" \
 *     --gcp-project "everclear-prod" \
 *     --gcp-secret "mark-web3-signer-pk-share2"
 *
 *   # Dry run with output (use only in secure local environment)
 *   npx ts-node scripts/shamir-split-secret.ts \
 *     --secret "0xabc123..." \
 *     --dry-run \
 *     --show-shares
 */

import * as fs from 'fs';
import * as readline from 'readline';

// Dynamically import to handle module resolution
async function main() {
  const { shamirSplitPair, shamirReconstructPair, parseShare, verifyShares } = await import(
    '../packages/core/src/shard/shamir'
  );

  // Parse command line arguments
  const args = parseArgs(process.argv.slice(2));

  console.log('🔐 Shamir Secret Splitting (2-of-2)');
  console.log('=====================================\n');

  // Get the secret
  let secret: string;

  if (args.secret) {
    secret = args.secret;
  } else if (args.secretFile) {
    if (!fs.existsSync(args.secretFile)) {
      console.error(`Error: Secret file not found: ${args.secretFile}`);
      process.exit(1);
    }
    secret = fs.readFileSync(args.secretFile, 'utf8').trim();
  } else if (args.interactive) {
    secret = await promptForSecret();
  } else {
    printHelp();
    process.exit(1);
  }

  if (!secret) {
    console.error('Error: Secret cannot be empty');
    process.exit(1);
  }

  console.log(`Secret length: ${secret.length} characters`);
  // SECURITY: Never log any part of the secret
  console.log('');

  // Generate shares
  console.log('Generating Shamir shares...');
  const { share1, share2 } = shamirSplitPair(secret);

  const parsed1 = parseShare(share1);
  const parsed2 = parseShare(share2);

  // SECURITY: Only log metadata, never share content
  console.log(`✓ Share 1: index=${parsed1.index}, length=${share1.length} hex chars`);
  console.log(`✓ Share 2: index=${parsed2.index}, length=${share2.length} hex chars\n`);

  // Verify reconstruction
  console.log('Verifying reconstruction...');
  if (!verifyShares(secret, share1, share2)) {
    console.error('❌ Reconstruction verification failed!');
    console.error('   The shares do not reconstruct to the original secret.');
    process.exit(1);
  }
  console.log('✓ Reconstruction verified successfully\n');

  // Dry run handling
  if (args.dryRun) {
    console.log('=== DRY RUN MODE ===\n');

    if (args.showShares) {
      console.warn('⚠️  SECURITY WARNING: Displaying shares in terminal.');
      console.warn('   Ensure terminal output is not being logged.\n');
      console.log('Share 1 (for AWS SSM):');
      console.log(share1);
      console.log('\nShare 2 (for GCP Secret Manager):');
      console.log(share2);
    } else {
      console.log('Shares generated but not displayed (use --show-shares to display)');
      console.log(`Share 1 length: ${share1.length} chars`);
      console.log(`Share 2 length: ${share2.length} chars`);
    }

    console.log('\n=== Manifest Entry Template ===');
    console.log(
      JSON.stringify(
        {
          path: '<field.path>',
          gcpSecretRef: {
            project: args.gcpProject || '<gcp-project>',
            secretId: args.gcpSecret || '<gcp-secret-id>',
          },
          method: 'shamir',
        },
        null,
        2,
      ),
    );
    return;
  }

  // Validate required arguments for storage
  if (!args.awsParam || !args.gcpProject || !args.gcpSecret) {
    console.log('To store shares, provide all of:');
    console.log('  --aws-param  : AWS SSM parameter name');
    console.log('  --gcp-project: GCP project ID');
    console.log('  --gcp-secret : GCP secret ID');
    console.log('\n⚠️  Shares NOT displayed for security. Use --dry-run --show-shares if needed.');
    return;
  }

  // Store Share 1 in AWS SSM
  console.log(`Storing Share 1 in AWS SSM: ${args.awsParam}`);
  try {
    const { SSMClient, PutParameterCommand } = await import('@aws-sdk/client-ssm');
    const ssmClient = new SSMClient({ region: args.awsRegion || 'us-east-1' });

    await ssmClient.send(
      new PutParameterCommand({
        Name: args.awsParam,
        Value: share1,
        Type: 'SecureString',
        Overwrite: true,
        Description: 'Shamir Share 1 for key sharding',
      }),
    );

    console.log('✓ Share 1 stored in AWS SSM\n');
  } catch (error) {
    console.error(`❌ Failed to store in AWS SSM: ${(error as Error).message}`);
    console.error('   Manual intervention required. Contact security team.');
    process.exit(1);
  }

  // Store Share 2 in GCP Secret Manager
  console.log(`Storing Share 2 in GCP: ${args.gcpProject}/${args.gcpSecret}`);
  try {
    const { setGcpSecret } = await import('../packages/core/src/shard/gcp-secret-manager');
    await setGcpSecret(args.gcpProject, args.gcpSecret, share2);
    console.log('✓ Share 2 stored in GCP Secret Manager\n');
  } catch (error) {
    console.error(`❌ Failed to store in GCP: ${(error as Error).message}`);
    console.error('   Manual intervention required. Contact security team.');
    // Note: Share 1 was already stored - need to clean up manually
    console.error('   WARNING: Share 1 was stored. Clean up may be required.');
    process.exit(1);
  }

  console.log('🎉 Secret successfully split and stored!');
  console.log('\nManifest entry to add:');
  console.log(
    JSON.stringify(
      {
        path: '<field.path.to.replace>',
        gcpSecretRef: {
          project: args.gcpProject,
          secretId: args.gcpSecret,
        },
        method: 'shamir',
      },
      null,
      2,
    ),
  );
}

interface Args {
  secret?: string;
  secretFile?: string;
  interactive?: boolean;
  awsParam?: string;
  awsRegion?: string;
  gcpProject?: string;
  gcpSecret?: string;
  dryRun?: boolean;
  showShares?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextArg = argv[i + 1];

    switch (arg) {
      case '-s':
      case '--secret':
        args.secret = nextArg;
        i++;
        break;
      case '-f':
      case '--secret-file':
        args.secretFile = nextArg;
        i++;
        break;
      case '-i':
      case '--interactive':
        args.interactive = true;
        break;
      case '--aws-param':
        args.awsParam = nextArg;
        i++;
        break;
      case '--aws-region':
        args.awsRegion = nextArg;
        i++;
        break;
      case '--gcp-project':
        args.gcpProject = nextArg;
        i++;
        break;
      case '--gcp-secret':
        args.gcpSecret = nextArg;
        i++;
        break;
      case '-d':
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--show-shares':
        args.showShares = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
    }
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  return args;
}

function printHelp() {
  console.log(`
Shamir Secret Splitting CLI

SECURITY: This tool handles sensitive cryptographic material.
          Never run where terminal output is logged.

Usage:
  npx ts-node scripts/shamir-split-secret.ts [options]

Options:
  -s, --secret <value>      Secret value to split
  -f, --secret-file <path>  Read secret from file
  -i, --interactive         Prompt for secret interactively
  
  --aws-param <name>        AWS SSM parameter name for Share 1
  --aws-region <region>     AWS region (default: us-east-1)
  --gcp-project <id>        GCP project ID for Share 2
  --gcp-secret <id>         GCP secret ID for Share 2
  
  -d, --dry-run             Generate shares without storing
  --show-shares             Display shares in output (SECURITY RISK)
  -h, --help                Show this help message

Examples:
  # Store directly (recommended - shares never displayed)
  npx ts-node scripts/shamir-split-secret.ts \\
    --secret "0xabc123..." \\
    --aws-param "/mark/web3_signer_pk_share1" \\
    --gcp-project "everclear-prod" \\
    --gcp-secret "mark-web3-signer-pk-share2"

  # Dry run with share output (use only locally)
  npx ts-node scripts/shamir-split-secret.ts \\
    --secret "0xabc123..." \\
    --dry-run \\
    --show-shares
`);
}

async function promptForSecret(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Note: For truly hidden input, you'd use a library like 'readline-sync'
    rl.question('Enter secret (will be visible): ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
