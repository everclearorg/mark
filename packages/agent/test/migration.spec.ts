import { runMigration } from '../src/migration';
import { Logger } from '@mark/logger';
import { execSync } from 'child_process';
import sinon, { createStubInstance, SinonStubbedInstance } from 'sinon';

jest.mock('child_process');

describe('runMigration', () => {
  let mockLogger: SinonStubbedInstance<Logger>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    sinon.restore();
  });

  it('should skip migrations when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;

    await runMigration(mockLogger);

    expect(mockLogger.warn.calledWith('DATABASE_URL not found, skipping migrations')).toBe(true);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('should run migrations with default path when DATABASE_URL is set', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    delete process.env.DATABASE_MIGRATION_PATH;

    (execSync as jest.Mock).mockReturnValue('Migration completed');

    await runMigration(mockLogger);

    expect(mockLogger.info.calledWithMatch('Running database migrations from')).toBe(true);
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('dbmate --url'),
      expect.objectContaining({
        encoding: 'utf-8',
      }),
    );
    expect(mockLogger.info.calledWithMatch('Database migration completed')).toBe(true);
  });

  it('should run migrations with custom migration path', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.DATABASE_MIGRATION_PATH = '/custom/path/migrations';

    (execSync as jest.Mock).mockReturnValue('Migration completed');

    await runMigration(mockLogger);

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('dbmate --url'),
      expect.objectContaining({
        encoding: 'utf-8',
        cwd: expect.stringContaining('packages/adapters/database'),
      }),
    );
  });

  it('should throw error when migration fails', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';

    const migrationError = new Error('Migration failed');
    (execSync as jest.Mock).mockImplementation(() => {
      throw migrationError;
    });

    await expect(runMigration(mockLogger)).rejects.toThrow('Database migration failed');

    expect(mockLogger.error.calledWithMatch('Failed to run database migration')).toBe(true);
  });

  it('should use correct dbmate command with no-dump-schema flag', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';

    (execSync as jest.Mock).mockReturnValue('Migration completed');

    await runMigration(mockLogger);

    const execCall = (execSync as jest.Mock).mock.calls[0][0];
    expect(execCall).toContain('--no-dump-schema');
    expect(execCall).toContain('up');
  });
});
