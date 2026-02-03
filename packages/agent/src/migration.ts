import { Logger } from '@mark/logger';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

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

    // Determine default migration path based on environment
    // Lambda uses /var/task, Fargate/ECS uses /app
    let defaultMigrationPath: string;
    const cwd = process.cwd();
    if (cwd === '/var/task' || existsSync('/var/task')) {
      // AWS Lambda environment
      defaultMigrationPath = '/var/task/db/migrations';
    } else {
      // Fargate/ECS or other container environments
      defaultMigrationPath = resolve(cwd, 'db/migrations');
    }

    const db_migration_path = process.env.DATABASE_MIGRATION_PATH ?? defaultMigrationPath;

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
