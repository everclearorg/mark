import { Logger } from '@mark/logger';
import { execSync } from 'child_process';
import { resolve } from 'path';

/**
 * Run database migrations using dbmate
 */
export async function runMigration(logger: Logger): Promise<void> {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.warn('DATABASE_URL not found, skipping migrations');
      return;
    }

    // Default to AWS Lambda environment path
    const db_migration_path = process.env.DATABASE_MIGRATION_PATH ?? '/var/task/db/migrations';

    let cwdOption: { cwd?: string } = {};

    // If an explicit db migration path is provided, set the cwd on execSync so it can be used for migrations
    if (process.env.DATABASE_MIGRATION_PATH) {
      const workspaceRoot = resolve(process.cwd(), '../..');
      cwdOption.cwd = resolve(workspaceRoot, 'packages/adapters/database');
    }

    logger.info(`Running database migrations from ${db_migration_path}...`);

    const result = execSync(`dbmate --url "${databaseUrl}" --migrations-dir ${db_migration_path} --no-dump-schema up`, {
      encoding: 'utf-8',
      ...cwdOption,
    });

    logger.info('Database migration completed', { output: result });
  } catch (error) {
    logger.error('Failed to run database migration', { error });
    throw new Error('Database migration failed - cannot continue with out-of-sync schema');
  }
}
