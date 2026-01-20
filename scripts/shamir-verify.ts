#!/usr/bin/env npx ts-node

/**
 * CLI Tool for verifying Shamir share reconstruction
 *
 * SECURITY WARNING: This tool handles sensitive cryptographic material.
 * - Never run in environments where terminal output is logged
 * - Use --quiet to suppress secret output
 * - Clear terminal history after use
 *
 * Usage:
 *   npx ts-node scripts/shamir-verify.ts --share1 "801abc..." --share2 "802def..."
 */

async function main() {
  const { shamirReconstructPair, parseShare, isValidShare } = await import(
    '../packages/core/src/shard/shamir'
  );

  const args = process.argv.slice(2);
  let share1: string | undefined;
  let share2: string | undefined;
  let showSecret = false;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--share1':
      case '-1':
        share1 = args[++i];
        break;
      case '--share2':
      case '-2':
        share2 = args[++i];
        break;
      case '--show-secret':
        showSecret = true;
        break;
      case '--help':
      case '-h':
        showHelp = true;
        break;
    }
  }

  if (showHelp || !share1 || !share2) {
    console.log(`
Shamir Share Verification CLI

SECURITY: This tool handles sensitive cryptographic material.
          Never run where terminal output is logged.

Usage:
  npx ts-node scripts/shamir-verify.ts --share1 <share> --share2 <share>

Options:
  -1, --share1 <value>   First Shamir share (from AWS SSM)
  -2, --share2 <value>   Second Shamir share (from GCP)
  --show-secret          Display reconstructed secret (SECURITY RISK)
  -h, --help             Show this help message

Example:
  # Verify shares can reconstruct (without showing secret)
  npx ts-node scripts/shamir-verify.ts \\
    --share1 "801abc123..." \\
    --share2 "802def456..."

  # Show reconstructed secret (use only in secure environment)
  npx ts-node scripts/shamir-verify.ts \\
    --share1 "801abc123..." \\
    --share2 "802def456..." \\
    --show-secret
`);
    process.exit(showHelp ? 0 : 1);
  }

  console.log('🔐 Shamir Share Verification');
  console.log('============================\n');

  // Validate shares
  console.log('Validating shares...');

  if (!isValidShare(share1)) {
    console.error('❌ Share 1 is invalid');
    process.exit(1);
  }
  const parsed1 = parseShare(share1);
  // SECURITY: Only log metadata, never share content
  console.log(`✓ Share 1: index=${parsed1.index}, length=${share1.length} hex chars`);

  if (!isValidShare(share2)) {
    console.error('❌ Share 2 is invalid');
    process.exit(1);
  }
  const parsed2 = parseShare(share2);
  console.log(`✓ Share 2: index=${parsed2.index}, length=${share2.length} hex chars`);

  if (parsed1.index === parsed2.index) {
    console.error('❌ Error: Both shares have the same index. They must be different shares.');
    process.exit(1);
  }

  if (parsed1.data.length !== parsed2.data.length) {
    console.warn('⚠️  Warning: Shares have different data lengths. This may indicate corruption.');
  }

  // Reconstruct
  console.log('\nReconstructing secret...');
  try {
    const secret = shamirReconstructPair(share1, share2);
    console.log('✓ Reconstruction successful!\n');

    // SECURITY: Only show secret if explicitly requested
    if (showSecret) {
      console.warn('⚠️  SECURITY WARNING: Displaying secret in terminal.');
      console.warn('   Ensure terminal output is not being logged.\n');
      console.log('=== Reconstructed Secret ===');
      console.log(secret);
      console.log('===========================');
    } else {
      console.log('Secret NOT displayed for security (use --show-secret to display)');
    }

    console.log(`\nSecret length: ${secret.length} characters`);
  } catch (error) {
    console.error('❌ Reconstruction failed:', (error as Error).message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
